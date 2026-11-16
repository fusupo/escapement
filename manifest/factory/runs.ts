import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FactoryError, blocked, nowIso, atomicWrite } from "./util.ts";
import { defaultTargetRef, resolveArtifactDir, type ProjectContext, type ArtifactSource } from "./context.ts";
import { tx, getRun, transitionRun, recordEvent, type RunRow, type AttemptRow } from "./state.ts";
import { listLocks, worktreeLock, BUILD_LOCK } from "./locks.ts";
import type { Owner } from "./owner.ts";
import { parseContract } from "./schemas.ts";

/** What an approval lets skills do without asking (§3.6). */
export const AUTHORIZES = ["commit", "push_branch", "open_pr", "run_validation"] as const;
export const EXCLUDES = ["merge", "force_push", "contract_change", "push_other_branches"] as const;

export type AuthorizationRow = {
  run_id: string;
  contract_digest: string;
  baseline_json: string;
  authorizes_json: string;
  status: "active" | "ended" | "revoked" | "superseded";
  approved_at: string;
  ended_at: string | null;
};

/** A run ID is the work item made path-safe, plus `-r{n}`: `fusupo/escapement#42` → `fusupo-escapement#42-r1`. */
export function runIdBase(workItem: string): string {
  const base = workItem
    .trim()
    .replace(/[^A-Za-z0-9#._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
  if (!base) throw new FactoryError("bad_work_item", `work item "${workItem}" has no usable characters`);
  return base;
}

/** `#42` or `owner/repo#42` → 42; anything else → null. */
export function issueNumberOf(workItem: string): number | null {
  const m = workItem.trim().match(/^(?:[\w.-]+\/[\w.-]+)?#(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function contractDigest(content: Buffer | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// ── start ────────────────────────────────────────────────────────────

export type StartOptions = {
  workItem: string;
  ctx: ProjectContext;
  artifactDir?: string;
  cwd?: string;
  issue?: number;
  manifestId?: string;
  targetRef?: string;
  workType?: string;
};

/**
 * Create a run in state `planned`, bound to the worktree, and its artifact
 * directory. The work item is any external identifier; no manifest
 * work_items row is needed. A worktree can have one open run at a time.
 */
export function startRun(db: Database, opts: StartOptions): RunRow & { artifact_source: ArtifactSource } {
  const base = runIdBase(opts.workItem);
  const targetRef = opts.targetRef ?? defaultTargetRef(opts.ctx.worktreePath);
  let source: ArtifactSource = "flag";
  const run = tx(db, () => {
    const open = db
      .prepare("SELECT run_id FROM factory_runs WHERE worktree_path = ? AND state != 'closed'")
      .get(opts.ctx.worktreePath) as { run_id: string } | undefined;
    if (open) {
      throw new FactoryError(
        "run_exists",
        `worktree ${opts.ctx.worktreePath} already has open run ${open.run_id}; close it first`,
      );
    }
    const taken = new Set(
      (db.prepare("SELECT run_id FROM factory_runs WHERE run_id LIKE ? ESCAPE '\\'").all(
        `${base.replace(/[\\%_]/g, "\\$&")}-r%`,
      ) as { run_id: string }[]).map((r) => r.run_id),
    );
    let n = 1;
    while (taken.has(`${base}-r${n}`)) n++;
    const runId = `${base}-r${n}`;
    const art = resolveArtifactDir({ artifactDir: opts.artifactDir, ctx: opts.ctx, runId, cwd: opts.cwd });
    source = art.source;
    db.prepare(
      `INSERT INTO factory_runs (run_id, work_item, repo, worktree_path, branch, target_ref, artifact_dir,
         issue_number, manifest_id, work_type, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
    ).run(
      runId,
      opts.workItem,
      opts.ctx.repo,
      opts.ctx.worktreePath,
      opts.ctx.branch,
      targetRef,
      art.dir,
      opts.issue ?? issueNumberOf(opts.workItem),
      opts.manifestId ?? null,
      opts.workType ?? null,
      nowIso(),
    );
    recordEvent(db, runId, "state_change", { entity: "run", from: null, to: "planned" });
    return getRun(db, runId);
  });
  mkdirSync(run.artifact_dir, { recursive: true });
  return { ...run, artifact_source: source };
}

// ── approve / revoke ─────────────────────────────────────────────────

export function activeAuthorization(db: Database, runId: string): AuthorizationRow | null {
  return (
    (db
      .prepare("SELECT * FROM factory_authorizations WHERE run_id = ? AND status = 'active'")
      .get(runId) as AuthorizationRow | undefined) ?? null
  );
}

/** Runs may be (re-)approved before validation starts. */
const APPROVABLE = ["planned", "approved", "implementing"] as const;

/**
 * Record the approved contract and issue an active authorization (§3.6).
 *
 * - The contract must be valid (schemas/factory/contract.schema.json), be
 *   for this run, and name the run's issue if it names one (`bad_contract`).
 * - Copies the contract to `{artifact_dir}/contract.json` and stores its digest.
 * - The first approval sets `deadline_at = approved_at + budget`. Later
 *   approvals never move it (budgets are not reset).
 * - Approving a different contract supersedes the active authorization.
 *   Approving the same contract again changes nothing.
 */
export function approveRun(
  db: Database,
  runId: string,
  opts: { contractFile: string; budgetMs: number; cwd?: string; owner?: Owner },
): { run: RunRow; authorization: AuthorizationRow; changed: boolean; superseded: string | null } {
  const path = resolve(opts.cwd ?? process.cwd(), opts.contractFile);
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw new FactoryError("no_contract", `cannot read contract file: ${path}`);
  }
  const contract = parseContract(content.toString("utf-8"), path);
  const digest = contractDigest(content);

  const result = tx(db, () => {
    const run = getRun(db, runId);
    if (!(APPROVABLE as readonly string[]).includes(run.state)) {
      throw new FactoryError("wrong_state", `run ${runId} is ${run.state}; only ${APPROVABLE.join(", ")} runs can be approved`);
    }
    if (contract.run_id !== run.run_id) {
      throw new FactoryError("bad_contract", `${path} is for run "${contract.run_id}", not ${run.run_id}`);
    }
    if (contract.issue != null && run.issue_number !== null && contract.issue !== run.issue_number) {
      throw new FactoryError("bad_contract", `${path} is for issue ${contract.issue}, but ${run.run_id} is issue ${run.issue_number}`);
    }
    const active = activeAuthorization(db, runId);
    if (active?.contract_digest === digest) {
      return { run, authorization: active, changed: false, superseded: null };
    }
    const now = new Date();
    if (active) {
      db.prepare(
        "UPDATE factory_authorizations SET status = 'superseded', ended_at = ? WHERE run_id = ? AND contract_digest = ?",
      ).run(nowIso(now), runId, active.contract_digest);
    }
    // A contract approved before (then revoked or superseded) is re-activated.
    db.prepare(
      `INSERT INTO factory_authorizations (run_id, contract_digest, baseline_json, authorizes_json, status, approved_at)
       VALUES (?, ?, '{}', ?, 'active', ?)
       ON CONFLICT (run_id, contract_digest) DO UPDATE SET status = 'active', approved_at = excluded.approved_at, ended_at = NULL`,
    ).run(runId, digest, JSON.stringify(AUTHORIZES), nowIso(now));
    db.prepare(
      "UPDATE factory_runs SET contract_digest = ?, deadline_at = COALESCE(deadline_at, ?) WHERE run_id = ?",
    ).run(digest, nowIso(new Date(now.getTime() + opts.budgetMs)), runId);
    recordEvent(db, runId, "state_change", {
      entity: "authorization",
      to: "active",
      contract_digest: digest,
      superseded: active?.contract_digest ?? null,
    });
    const updated = run.state === "planned" ? transitionRun(db, runId, "approved", { owner: opts.owner }) : getRun(db, runId);
    return {
      run: updated,
      authorization: activeAuthorization(db, runId)!,
      changed: true,
      superseded: active?.contract_digest ?? null,
    };
  });
  atomicWrite(join(result.run.artifact_dir, "contract.json"), content);
  return result;
}

/** End the active authorization (§3.6). Available past the run deadline. */
export function revokeRun(db: Database, runId: string): AuthorizationRow {
  return tx(db, () => {
    getRun(db, runId);
    const active = activeAuthorization(db, runId);
    if (!active) throw new FactoryError("no_active_authorization", `run ${runId} has no active authorization`);
    db.prepare(
      "UPDATE factory_authorizations SET status = 'revoked', ended_at = ? WHERE run_id = ? AND contract_digest = ?",
    ).run(nowIso(), runId, active.contract_digest);
    recordEvent(db, runId, "state_change", { entity: "authorization", to: "revoked", contract_digest: active.contract_digest });
    return db
      .prepare("SELECT * FROM factory_authorizations WHERE run_id = ? AND contract_digest = ?")
      .get(runId, active.contract_digest) as AuthorizationRow;
  });
}

// ── preconditions for commands that execute work ─────────────────────

export function deadlinePassed(run: RunRow, now: number = Date.now()): boolean {
  return run.deadline_at !== null && Date.parse(run.deadline_at) <= now;
}

/**
 * Commands that start execution call this first (§4.1). Past the deadline
 * the run moves to `escalated` and the command is blocked with
 * `run_deadline`. Without an active authorization it is blocked with
 * `not_authorized`.
 */
export function requireExecutable(db: Database, runId: string, owner?: Owner): { run: RunRow; authorization: AuthorizationRow } {
  const run = getRun(db, runId);
  if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
  if (deadlinePassed(run)) {
    if (run.state !== "escalated") {
      transitionRun(db, runId, "escalated", { reason: "run_deadline", owner });
    }
    throw blocked("run_deadline", `run ${runId} passed its deadline (${run.deadline_at})`);
  }
  if (run.state === "blocked" || run.state === "escalated") {
    throw blocked("run_halted", `run ${runId} is ${run.state}${run.state_reason ? ` (${run.state_reason})` : ""}`);
  }
  const authorization = activeAuthorization(db, runId);
  if (!authorization) throw blocked("not_authorized", `run ${runId} has no active authorization`);
  return { run, authorization };
}

// ── status ───────────────────────────────────────────────────────────

export function runStatus(db: Database, runId: string) {
  const run = getRun(db, runId);
  const authorizations = db
    .prepare("SELECT * FROM factory_authorizations WHERE run_id = ? ORDER BY approved_at")
    .all(runId) as AuthorizationRow[];
  const attempts = db
    .prepare("SELECT * FROM factory_attempts WHERE run_id = ? ORDER BY attempt")
    .all(runId) as AttemptRow[];
  const locks = listLocks(db).filter(
    (l) => l.holder.run_id === runId || l.name === worktreeLock(run.worktree_path) || l.name === BUILD_LOCK,
  );
  return {
    run,
    deadline_passed: deadlinePassed(run),
    authorization: authorizations.find((a) => a.status === "active") ?? null,
    authorizations: authorizations.map((a) => ({ ...a, authorizes_json: undefined, authorizes: JSON.parse(a.authorizes_json) })),
    attempts: attempts.map((a) => ({ ...a, owner_json: undefined, owner: a.owner_json ? JSON.parse(a.owner_json) : null })),
    locks,
  };
}

export function listRuns(db: Database, opts: { all?: boolean } = {}): RunRow[] {
  return db
    .prepare(`SELECT * FROM factory_runs ${opts.all ? "" : "WHERE state != 'closed'"} ORDER BY started_at, run_id`)
    .all() as RunRow[];
}
