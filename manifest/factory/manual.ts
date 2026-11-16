import type { Database } from "better-sqlite3";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { FactoryError, blocked, atomicWrite, nowIso } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunState } from "./state.ts";
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
 */

export type ManualOutcome = "pass" | "fail";

export type RecordManualResult = {
  run_id: string;
  attempt: number;
  evidence_id: string;
  outcome: ManualOutcome;
  noop: boolean;
  recorded: { evidence_id: string; outcome: ManualOutcome }[];
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
};

export async function recordManual(
  db: Database,
  runId: string,
  evidenceId: string,
  outcome: string,
  opts: { note: string; recorder?: string; owner: Owner; lockWaitMs: number },
): Promise<RecordManualResult> {
  if (outcome !== "pass" && outcome !== "fail") throw new FactoryError("usage", `outcome must be pass or fail, not ${outcome}`);
  const note = opts.note.trim();
  if (!note) throw new FactoryError("usage", "record-manual needs a --note saying what was checked");
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

    const records = new Map<string, Recorded>();
    const rows = db
      .prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'manual_outcome' ORDER BY id")
      .all(runId) as { detail_json: string }[];
    for (const { detail_json } of rows) {
      const d = JSON.parse(detail_json) as Recorded;
      if (d.attempt === attempt && d.head_sha === report.head_sha && d.contract_digest === report.contract_digest) {
        records.set(d.evidence_id, d);
      }
    }

    const previous = records.get(evidenceId);
    const noop = previous?.outcome === outcome;
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
      noop,
      recorded: done.map((r) => ({ evidence_id: r.evidence_id, outcome: r.outcome })),
      pending: pendingIds.filter((id) => !records.has(id)),
      resolved,
      report_path: reportPath,
      report_revision: revision,
      run_state: after.state,
      pr_number: after.pr_number,
      refresh_pr: resolved !== null && after.pr_number !== null,
    };
  });
}
