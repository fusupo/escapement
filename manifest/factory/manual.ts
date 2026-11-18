import type { Database } from "better-sqlite3";
import { realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FactoryError, blocked, atomicWrite, nowIso } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunRow, type RunState } from "./state.ts";
import { attemptDir, currentReport } from "./attempts.ts";
import { git } from "./context.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { schemaErrors } from "./schemas.ts";
import type { Owner } from "./owner.ts";

/**
 * `factory record-manual <run_id> <evidence_id> pass|fail --note …` (§5.5):
 * a human's outcome for `manual` evidence the report left `pending_manual`.
 *
 * - Bound to the current report: its contract must be the run's approved
 *   contract (`stale_contract`) and HEAD must still be its head_sha
 *   (`stale_report`); a new commit invalidates earlier records along with
 *   the report.
 * - Each record is a `manual_outcome` event. Recording the same outcome
 *   again is a no-op; a different one replaces it until the report resolves.
 * - When every manual item is `pass`, or any is `fail`, the runner writes
 *   the next report revision, `report.r{k}.json`, with the outcome, the
 *   evidence marked passed or failed and the human outcomes. The earlier
 *   revisions are never changed. A `fail` adds a blocking finding and
 *   escalates the run.
 * - Bookkeeping: it works past the run deadline, under the worktree lock.
 * - Agent-assisted (#103): `--assisted` marks an outcome the human decided
 *   from the agent's walk-through (validate-work), and each `--attachment`
 *   names one of its files, which must lie under the run's
 *   `{artifact_dir}/manual/{evidence_id}/`. The recorder is still the human.
 * - Before the report resolves, the outcomes recorded so far are listed by
 *   this result, `factory status` and the PR section (`manualProgress`), so
 *   checks can be worked through one at a time.
 */

export type ManualOutcome = "pass" | "fail";

/** One recorded outcome, as the result, status and the PR section show it. */
export type RecordedView = {
  evidence_id: string;
  outcome: ManualOutcome;
  note: string;
  recorder: string;
  recorded_at: string;
  assisted: boolean;
  attachments: string[];
};

export type RecordManualResult = {
  run_id: string;
  attempt: number;
  evidence_id: string;
  outcome: ManualOutcome;
  assisted: boolean;
  attachments: string[];
  noop: boolean;
  recorded: RecordedView[];
  pending: string[];
  resolved: ManualOutcome | null;
  report_path: string;
  report_revision: number;
  run_state: RunState;
  pr_number: number | null;
  /** The run has a PR whose report section is now out of date: run `factory pr` again. */
  refresh_pr: boolean;
};

type Recorded = {
  attempt: number;
  evidence_id: string;
  outcome: ManualOutcome;
  note: string;
  recorder: string;
  head_sha: string;
  contract_digest: string;
  recorded_at: string;
  /** Absent in records from before #103: false and []. */
  assisted?: boolean;
  attachments?: string[];
};

export const MAX_ATTACHMENTS = 20;

const view = (r: Recorded): RecordedView => ({
  evidence_id: r.evidence_id,
  outcome: r.outcome,
  note: r.note,
  recorder: r.recorder,
  recorded_at: r.recorded_at,
  assisted: r.assisted ?? false,
  attachments: r.attachments ?? [],
});

/** The latest record per evidence ID for one attempt's report (its head_sha and contract). */
function recordsFor(db: Database, runId: string, attempt: number, headSha: string, contractDigest: string): Map<string, Recorded> {
  const records = new Map<string, Recorded>();
  const rows = db
    .prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'manual_outcome' ORDER BY id")
    .all(runId) as { detail_json: string }[];
  for (const { detail_json } of rows) {
    const d = JSON.parse(detail_json) as Recorded;
    if (d.attempt === attempt && d.head_sha === headSha && d.contract_digest === contractDigest) {
      records.set(d.evidence_id, d);
    }
  }
  return records;
}

/**
 * The manual checks of the run's current report while it is still
 * `pending_manual`: which await a human and what has been recorded so far.
 * Null when the current report isn't pending (none, or already resolved).
 */
export function manualProgress(db: Database, run: RunRow): { attempt: number; pending: string[]; recorded: RecordedView[] } | null {
  let current;
  try {
    current = currentReport(db, run);
  } catch {
    return null;
  }
  if (!current || current.report.outcome !== "pending_manual") return null;
  const { report, attempt } = current;
  const pendingIds = report.evidence.filter((e) => e.executed === "pending_manual").map((e) => e.id);
  const records = recordsFor(db, run.run_id, attempt, report.head_sha, report.contract_digest);
  return {
    attempt,
    pending: pendingIds.filter((id) => !records.has(id)),
    recorded: pendingIds.filter((id) => records.has(id)).map((id) => view(records.get(id)!)),
  };
}

/**
 * Check `--attachment` paths: each an existing regular file whose real path
 * lies under `{artifact_dir}/manual/{evidence_id}/`. Returns them relative to
 * the artifact dir, in the given order, without duplicates.
 */
function checkAttachments(artifactDir: string, evidenceId: string, paths: string[]): string[] {
  if (!paths.length) return [];
  if (paths.length > MAX_ATTACHMENTS) {
    throw new FactoryError("usage", `at most ${MAX_ATTACHMENTS} attachments, not ${paths.length}`);
  }
  const dir = join(artifactDir, "manual", evidenceId);
  let realDir: string;
  let realBase: string;
  try {
    realBase = realpathSync(artifactDir);
    realDir = realpathSync(dir);
  } catch {
    throw blocked("bad_attachment", `${dir} doesn't exist; attachments go under the evidence's manual dir`);
  }
  const out: string[] = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw blocked("bad_attachment", `attachment ${p} doesn't exist`);
    }
    if (!real.startsWith(realDir + sep)) {
      throw blocked("bad_attachment", `attachment ${p} is outside ${dir}`);
    }
    if (!statSync(real).isFile()) throw blocked("bad_attachment", `attachment ${p} isn't a regular file`);
    const rel = relative(realBase, real).split(sep).join("/");
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function recordManual(
  db: Database,
  runId: string,
  evidenceId: string,
  outcome: string,
  opts: { note: string; recorder?: string; assisted?: boolean; attachments?: string[]; owner: Owner; lockWaitMs: number },
): Promise<RecordManualResult> {
  if (outcome !== "pass" && outcome !== "fail") throw new FactoryError("usage", `outcome must be pass or fail, not ${outcome}`);
  const note = opts.note.trim();
  if (!note) throw new FactoryError("usage", "record-manual needs a --note saying what was checked");
  const assisted = opts.assisted ?? false;
  const attachmentArgs = opts.attachments ?? [];
  if (attachmentArgs.length && !assisted) {
    throw new FactoryError("usage", "--attachment is only for an agent-assisted check: add --assisted");
  }
  const recorder = (opts.recorder ?? userInfo().username).trim() || "unknown";
  const run0 = getRun(db, runId);
  if (run0.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);

  return withLocks(db, [worktreeLock(run0.worktree_path)], opts.owner, { waitMs: opts.lockWaitMs, runId }, () => {
    const run = getRun(db, runId);
    if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
    const current = currentReport(db, run);
    if (!current) throw blocked("no_report", `run ${runId} has no complete validation report`);
    const { report, attempt } = current;
    if (report.outcome !== "pending_manual") {
      if (report.manual_outcomes?.length) {
        throw blocked("already_resolved", `the manual checks of attempt ${attempt} were resolved as ${report.outcome} (report revision ${current.revision})`);
      }
      throw blocked("not_pending_manual", `attempt ${attempt}'s report is ${report.outcome}; nothing awaits a human`);
    }
    if (report.contract_digest !== run.contract_digest) {
      throw blocked("stale_contract", `the report was validated against ${report.contract_digest}, not the approved ${run.contract_digest}`);
    }
    const head = git(["rev-parse", "HEAD"], run.worktree_path);
    if (head !== report.head_sha) {
      throw blocked("stale_report", `HEAD is ${head}, but the report describes ${report.head_sha}; validate again`);
    }
    const pendingIds = report.evidence.filter((e) => e.executed === "pending_manual").map((e) => e.id);
    if (!pendingIds.includes(evidenceId)) {
      throw blocked("unknown_evidence", `${evidenceId} isn't manual evidence awaiting a human; pending: ${pendingIds.join(", ") || "none"}`);
    }

    const attachments = checkAttachments(run.artifact_dir, evidenceId, attachmentArgs);
    const records = recordsFor(db, runId, attempt, report.head_sha, report.contract_digest);

    const previous = records.get(evidenceId);
    const noop =
      previous?.outcome === outcome &&
      (previous.assisted ?? false) === assisted &&
      sameList(previous.attachments ?? [], attachments);
    if (!noop) {
      const rec: Recorded = {
        attempt,
        evidence_id: evidenceId,
        outcome,
        note,
        recorder,
        head_sha: report.head_sha,
        contract_digest: report.contract_digest,
        recorded_at: nowIso(),
        ...(assisted ? { assisted: true, attachments } : {}),
      };
      recordEvent(db, runId, "manual_outcome", { ...rec, replaces: previous?.outcome ?? null, owner: opts.owner });
      records.set(evidenceId, rec);
    }

    const done = pendingIds.filter((id) => records.has(id)).map((id) => records.get(id)!);
    const failed = done.filter((r) => r.outcome === "fail");
    const resolved: ManualOutcome | null = failed.length ? "fail" : done.length === pendingIds.length ? "pass" : null;
    let reportPath = current.path;
    let revision = current.revision;

    if (resolved) {
      revision = current.revision + 1;
      reportPath = join(attemptDir(run.artifact_dir, attempt), `report.r${revision}.json`);
      const outcomes = new Map(done.map((r) => [r.evidence_id, r]));
      const { revision: _drop, ...base } = report as typeof report & { revision?: number };
      const next = {
        ...base,
        revision,
        supersedes: basename(current.path),
        outcome: resolved,
        evidence: report.evidence.map((e) => {
          const r = outcomes.get(e.id);
          return r ? { ...e, executed: r.outcome === "pass" ? "passed" : "failed" } : e;
        }),
        findings: [
          ...report.findings,
          ...failed.map((r) => ({ id: `manual:${r.evidence_id}`, severity: "blocking", detail: `manual check failed: ${r.note} (${r.recorder})` })),
        ],
        manual_outcomes: done.map((r) => ({
          evidence_id: r.evidence_id,
          outcome: r.outcome,
          note: r.note,
          recorder: r.recorder,
          recorded_at: r.recorded_at,
          ...(r.assisted ? { assisted: true, attachments: r.attachments ?? [] } : {}),
        })),
      };
      const problems = schemaErrors("report", next);
      if (problems.length) throw new FactoryError("internal", `report revision ${revision} is invalid: ${problems.join("; ")}`);
      atomicWrite(reportPath, JSON.stringify(next, null, 2) + "\n");
      tx(db, () => {
        db.prepare("UPDATE factory_attempts SET outcome = ? WHERE run_id = ? AND attempt = ?").run(resolved, runId, attempt);
        recordEvent(db, runId, "state_change", {
          entity: "report",
          to: `r${revision}`,
          attempt,
          outcome: resolved,
          supersedes: basename(current.path),
          owner: opts.owner,
        });
        const now = getRun(db, runId);
        if (resolved === "fail" && now.state !== "blocked" && now.state !== "escalated") {
          transitionRun(db, runId, "escalated", { reason: `manual:${failed[0].evidence_id}`, owner: opts.owner });
        }
      });
    }

    const after = getRun(db, runId);
    return {
      run_id: runId,
      attempt,
      evidence_id: evidenceId,
      outcome,
      assisted,
      attachments,
      noop,
      recorded: done.map(view),
      pending: pendingIds.filter((id) => !records.has(id)),
      resolved,
      report_path: reportPath,
      report_revision: revision,
      run_state: after.state,
      pr_number: after.pr_number,
      // A new record changes the PR section even before the report resolves.
      refresh_pr: (resolved !== null || !noop) && after.pr_number !== null,
    };
  });
}
