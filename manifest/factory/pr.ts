import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, blocked, atomicWrite } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunRow, type RunState } from "./state.ts";
import { faultPoint } from "./fault.ts";
import { activeAuthorization, contractDigest, deadlinePassed, type AuthorizationRow } from "./runs.ts";
import { currentReport } from "./attempts.ts";
import { manualProgress } from "./manual.ts";
import { identityHolds } from "./revision.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { agentToken, gh, ghJson, pushBranch, remoteOf } from "./github.ts";
import { renderSection, withSection, type ReportView, type CriterionView, type AttemptSummary } from "./report-section.ts";
import type { Owner } from "./owner.ts";

/**
 * `factory pr <run_id>` (§4.8): open or update the run's PR, idempotently,
 * as the agent's GitHub identity. Under the worktree lock:
 *
 * 1. Check: the run is `validated` (or `pr_open`, or escalated with a PR,
 *    to refresh it); an active authorization allowing push_branch and
 *    open_pr; contract.json is the approved contract; the latest complete
 *    attempt's current report is for that contract; HEAD equals the
 *    report's head_sha and the tree is clean.
 * 2. Look up the open PR whose head is the run's branch (in the run's repo).
 * 3. None: refuse past the deadline (the run escalates), then push the
 *    branch and create the PR. One: push and edit its body.
 * 4. Record the PR number on the run (`validated` → `pr_open`).
 *
 * A crash anywhere is repaired by running the command again: step 2 finds
 * the PR an earlier call created, and recording the same number is a no-op.
 * The body is the host's narrative (`--body-file`) plus the runner's
 * report section between markers; on update only the section is replaced.
 */

export type PrResult = {
  run_id: string;
  pr_number: number;
  url: string;
  /** created; updated (the recorded PR); recovered (an unrecorded PR an earlier, interrupted call created, now recorded). */
  action: "created" | "updated" | "recovered";
  state: RunState;
  head_sha: string;
  attempt: number;
  report_revision: number;
  outcome: string | null;
  body_path: string;
};

type GhPr = { number: number; url: string; body?: string; headRefName: string; headRepositoryOwner?: { login: string } | null };

const PR_STATES: readonly RunState[] = ["validated", "pr_open", "escalated"];

function readJson<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    throw new FactoryError("unreadable", `cannot read ${what} ${path}: ${(err as Error).message}`);
  }
}

function checkAuthorization(db: Database, run: RunRow): AuthorizationRow {
  const auth = activeAuthorization(db, run.run_id);
  if (!auth) throw blocked("not_authorized", `run ${run.run_id} has no active authorization`);
  const allows = JSON.parse(auth.authorizes_json) as string[];
  for (const need of ["push_branch", "open_pr"]) {
    if (!allows.includes(need)) throw blocked("not_authorized", `run ${run.run_id}'s authorization doesn't allow ${need}`);
  }
  const path = join(run.artifact_dir, "contract.json");
  const digest = existsSync(path) ? contractDigest(readFileSync(path)) : null;
  if (digest !== auth.contract_digest || digest !== run.contract_digest) {
    throw blocked("contract_mismatch", `${path} is not the approved contract (${auth.contract_digest})`);
  }
  return auth;
}

export async function openPr(
  db: Database,
  runId: string,
  opts: { owner: Owner; lockWaitMs: number; title?: string; narrative?: string; env?: NodeJS.ProcessEnv; now?: number },
): Promise<PrResult> {
  const run0 = getRun(db, runId);
  if (run0.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
  return withLocks(db, [worktreeLock(run0.worktree_path)], opts.owner, { waitMs: opts.lockWaitMs, runId }, () => {
    const run = getRun(db, runId);
    const refresh = run.pr_number !== null;
    if (!PR_STATES.includes(run.state) || (run.state === "escalated" && !refresh)) {
      throw blocked(
        "not_validated",
        `run ${runId} is ${run.state}${run.state_reason ? ` (${run.state_reason})` : ""}; a PR needs a validated run`,
      );
    }
    checkAuthorization(db, run);

    const current = currentReport(db, run);
    if (!current) throw blocked("no_report", `run ${runId} has no complete validation report`);
    const { report } = current;
    if (!refresh && report.outcome !== "pass" && report.outcome !== "pending_manual") {
      throw blocked("not_validated", `the report for attempt ${report.attempt} is ${report.outcome}; a PR needs pass or pending_manual`);
    }
    if (report.contract_digest !== run.contract_digest) {
      throw blocked("stale_report", `the report was validated against ${report.contract_digest}, not the approved ${run.contract_digest}`);
    }
    const identity = identityHolds(run.worktree_path, report.head_sha);
    if (!identity.ok) throw blocked("head_moved", `${identity.detail}; validate again before opening the PR`);

    const env = opts.env ?? process.env;
    const token = agentToken(env);
    const remote = remoteOf(run.worktree_path, run.repo);
    const owner = run.repo.split("/")[0].toLowerCase();
    const open = ghJson<GhPr[]>(
      ["pr", "list", "-R", remote.ghRepo, "--head", run.branch, "--state", "open", "--json", "number,url,body,headRefName,headRepositoryOwner"],
      { token, env },
    ).filter((p) => p.headRefName === run.branch && (!p.headRepositoryOwner || p.headRepositoryOwner.login.toLowerCase() === owner));
    if (open.length > 1) {
      throw blocked("pr_conflict", `${open.length} open PRs have head ${run.branch}: ${open.map((p) => `#${p.number}`).join(", ")}`);
    }
    const existing = open[0] ?? null;
    if (run.pr_number !== null && existing && existing.number !== run.pr_number) {
      throw blocked("pr_conflict", `run ${runId} recorded PR #${run.pr_number}, but the open PR for ${run.branch} is #${existing.number}`);
    }
    if (run.pr_number !== null && !existing) {
      throw blocked("pr_not_open", `run ${runId}'s PR #${run.pr_number} is no longer open`);
    }
    if (!existing) {
      if (deadlinePassed(run, opts.now)) {
        transitionRun(db, runId, "escalated", { reason: "run_deadline", owner: opts.owner });
        throw blocked("run_deadline", `run ${runId} passed its deadline (${run.deadline_at})`);
      }
      if (!opts.title?.trim()) throw new FactoryError("usage", "--title is needed to create the PR");
    }

    const contract = readJson<{ criteria: CriterionView[] }>(join(run.artifact_dir, "contract.json"), "contract");
    // Outcomes recorded so far, while the report still awaits other checks (#103).
    const progress = report.outcome === "pending_manual" ? manualProgress(db, run) : null;
    const view = progress?.recorded.length ? { ...report, manual_recorded: progress.recorded } : report;
    const section = renderSection(view, contract.criteria, run.branch, attemptHistory(db, run.run_id));
    const base = opts.narrative ?? existing?.body ?? "";
    const body = withSection(base, section);
    const bodyPath = join(run.artifact_dir, "pr", "body.md");
    atomicWrite(bodyPath, body);

    pushBranch({ worktree: run.worktree_path, remote, repo: run.repo, branch: run.branch, token });
    let number: number;
    let url: string;
    if (existing) {
      // The REST API, not `gh pr edit`: pr edit also queries classic Projects
      // over GraphQL and fails wherever that API is deprecated (#65).
      const args = ["api", "-X", "PATCH", `repos/${run.repo}/pulls/${existing.number}`, "-F", `body=@${bodyPath}`];
      if (remote.host && remote.host !== "github.com") args.push("--hostname", remote.host);
      if (opts.title?.trim()) args.push("-f", `title=${opts.title.trim()}`);
      gh(args, { token, env });
      number = existing.number;
      url = existing.url;
    } else {
      const base = run.target_ref.replace(/^origin\//, "");
      url = gh(
        ["pr", "create", "-R", remote.ghRepo, "--base", base, "--head", run.branch, "--title", opts.title!.trim(), "--body-file", bodyPath],
        { token, env },
      )
        .split("\n")
        .pop()!
        .trim();
      const m = url.match(/\/pull\/(\d+)\b/);
      if (!m) throw new FactoryError("gh_failed", `gh pr create printed no PR URL: ${url}`);
      number = Number(m[1]);
      faultPoint("pr.created");
    }

    const action = !existing ? "created" : run.pr_number === null ? "recovered" : "updated";
    const updated = tx(db, () => {
      db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(number, runId);
      recordEvent(db, runId, "state_change", {
        entity: "pr",
        to: action,
        pr_number: number,
        url,
        head_sha: report.head_sha,
        attempt: report.attempt,
        report_revision: current.revision,
        owner: opts.owner,
      });
      return getRun(db, runId).state === "validated"
        ? transitionRun(db, runId, "pr_open", { owner: opts.owner, reason: `PR #${number}` })
        : getRun(db, runId);
    });
    faultPoint("pr.recorded");
    return {
      run_id: runId,
      pr_number: number,
      url,
      action,
      state: updated.state,
      head_sha: report.head_sha,
      attempt: report.attempt,
      report_revision: current.revision,
      outcome: report.outcome,
      body_path: bodyPath,
    };
  });
}

/** Every attempt of the run, for the PR's history table (§6.2). */
export function attemptHistory(db: Database, runId: string): AttemptSummary[] {
  const rows = db
    .prepare(
      "SELECT attempt, status, outcome, failed_phase, error_cause, error_reason, findings_json FROM factory_attempts WHERE run_id = ? ORDER BY attempt",
    )
    .all(runId) as (Omit<AttemptSummary, "blocking"> & { findings_json: string | null })[];
  return rows.map(({ findings_json, ...a }) => {
    let blocking = 0;
    try {
      blocking = ((findings_json ? JSON.parse(findings_json) : []) as { severity: string }[]).filter((f) => f.severity === "blocking").length;
    } catch {
      blocking = 0;
    }
    return { ...a, blocking };
  });
}
