import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeAuthorization, contractDigest, deadlinePassed } from "./runs.ts";
import { currentReport } from "./attempts.ts";
import type { AttemptRow, RunRow, RunState } from "./state.ts";
import { reentries, reentrySummary, type ReentrySummary, type ReentryTrigger } from "./reentry.ts";

/**
 * Does the current worktree have a factory run whose active authorization
 * lets skills act without asking (§3.6)? Skills ask this one question
 * before skipping a confirmation, and route on the answer.
 *
 * Matched only when all hold:
 * - a non-closed run is bound to this worktree;
 * - its repo and branch are the worktree's current repo and branch;
 * - the run has an active authorization;
 * - `{artifact_dir}/contract.json` hashes to the authorized digest, which
 *   is also the run's contract digest;
 * - the run isn't waiting on a human (blocked, escalated) or unapproved;
 * - the run deadline hasn't passed.
 *
 * Read-only: it never changes the run, even past the deadline.
 */

export const AUTH_REASONS = [
  "no_database",
  "not_a_repo",
  "detached_head",
  "no_run",
  "repo_mismatch",
  "branch_mismatch",
  "no_active_authorization",
  "contract_missing",
  "contract_changed",
  "run_halted",
  "run_deadline",
] as const;
export type AuthReason = (typeof AUTH_REASONS)[number];

/** What the host should do next for a matched run. Advisory; the runner still checks each command. */
export type NextStep = "implement" | "validate" | "resume" | "review" | "pr" | "refresh_pr" | "await_merge";

export type LatestAttempt = { attempt: number; status: string; outcome: string | null; head_sha: string };

/**
 * What the implementer goes back to fix (§6.2: findings only): the last
 * attempt's blocking findings and, for an error, its cause. Set while the
 * run is implementing after a failed or errored attempt, through the fix
 * loop or `factory continue`; null otherwise.
 *
 * After a re-entry (#97, `factory continue` on a run with a PR), it is set
 * too, with the re-entry's `trigger` and the operator's `reason`:
 * - `review_finding`, `operator_request`: no blocking findings (the
 *   attempt passed); the reason is the work;
 * - `manual_check_failed`: the `manual:{id}` blocking findings of the
 *   attempt's current report revision, which record-manual writes;
 * - `attempt_failed`: the attempt's blocking findings, as in the fix loop.
 * A plain fix-loop handoff has `trigger` and `reason` null.
 */
export type FixHandoff = {
  attempt: number;
  /** The attempt's outcome: fail or error, or (re-entry from an open PR) pass or pending_manual. */
  outcome: string;
  trigger: ReentryTrigger | null;
  reason: string | null;
  error: { cause: string; reason: string } | null;
  blocking_findings: { id: string; detail: string; location?: string }[];
  /** The attempt's current report, with every finding and the logs. */
  report_path: string | null;
};

export type AuthorizationMatch =
  | { matched: false; reasons: AuthReason[]; run_id: string | null; state: RunState | null }
  | {
      matched: true;
      reasons: [];
      run_id: string;
      state: RunState;
      repo: string;
      branch: string;
      target_ref: string;
      worktree_path: string;
      artifact_dir: string;
      contract_path: string;
      contract_digest: string;
      authorizes: string[];
      approved_at: string;
      deadline_at: string | null;
      issue_number: number | null;
      pr_number: number | null;
      latest_attempt: LatestAttempt | null;
      next: NextStep;
      fix: FixHandoff | null;
      /** Re-entries after the PR opened (#97): how many, and the latest's trigger, attempt and reason; null if never re-entered. */
      reentry: ReentrySummary | null;
    };

const MATCHABLE: readonly RunState[] = ["approved", "implementing", "validating", "validated", "pr_open"];

export function noMatch(reason: AuthReason, run: RunRow | null = null): AuthorizationMatch {
  return { matched: false, reasons: [reason], run_id: run?.run_id ?? null, state: run?.state ?? null };
}

/**
 * - `resume`: an attempt was left mid-way (checks running or finalizing,
 *   e.g. after a crash), or a completed attempt's run transition is still
 *   owed; `factory resume` reconciles it and names the follow-up command.
 * - `review`: checks are done, the review is outstanding.
 * - `validate`: the run is validating but has no usable attempt (the last
 *   one was interrupted, or none was allocated): validate again.
 * - `prCurrent`: the open PR already shows the current report (same attempt
 *   and revision as when `factory pr` last wrote it), so there's nothing to
 *   refresh and the run waits for the operator's merge.
 */
export function nextStep(state: RunState, latest: LatestAttempt | null, prCurrent = false): NextStep {
  if (latest?.status === "checks_running" || latest?.status === "finalizing") return "resume";
  if (latest?.status === "awaiting_review") return "review";
  if (state === "validating") return latest?.status === "complete" ? "resume" : "validate";
  if (state === "validated") return "pr";
  if (state === "pr_open") return prCurrent ? "await_merge" : "refresh_pr";
  return "implement";
}

/** Whether the run's PR was last written from its current report. */
function prShowsCurrentReport(db: Database, run: RunRow): boolean {
  const last = db
    .prepare(
      "SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change' AND json_extract(detail_json, '$.entity') = 'pr' ORDER BY id DESC LIMIT 1",
    )
    .get(run.run_id) as { detail_json: string } | undefined;
  if (!last) return false;
  const written = JSON.parse(last.detail_json) as { attempt?: number; report_revision?: number };
  let current;
  try {
    current = currentReport(db, run);
  } catch {
    return false;
  }
  return current !== null && written.attempt === current.attempt && written.report_revision === current.revision;
}

type Finding = { id: string; severity: string; detail: string; location?: string };

const blockingOf = (findings: Finding[]) =>
  findings.filter((f) => f.severity === "blocking").map((f) => ({ id: f.id, detail: f.detail, ...(f.location ? { location: f.location } : {}) }));

/** The fix handoff for a run back in implementing after a failed or errored attempt, or a re-entry (see FixHandoff). */
export function fixHandoff(db: Database, run: RunRow): FixHandoff | null {
  if (run.state !== "implementing") return null;
  const a = db
    .prepare("SELECT * FROM factory_attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1")
    .get(run.run_id) as AttemptRow | undefined;
  if (!a || a.status !== "complete") return null;
  const back = reentries(db, run.run_id).filter((r) => r.attempt === a.attempt).pop() ?? null;
  if (!back && a.outcome !== "fail" && a.outcome !== "error") return null;
  let findings: Finding[] = [];
  try {
    findings = a.findings_json ? JSON.parse(a.findings_json) : [];
  } catch {
    findings = [];
  }
  let blocking = blockingOf(findings);
  let reportPath = a.report_path ?? null;
  if (back?.trigger === "review_finding" || back?.trigger === "operator_request") blocking = [];
  if (back?.trigger === "manual_check_failed") {
    // record-manual writes the manual:{id} findings into the report's new revision only.
    try {
      const current = currentReport(db, run);
      if (current && current.attempt === a.attempt) {
        blocking = blockingOf((current.report.findings ?? []) as Finding[]);
        reportPath = current.path;
      }
    } catch {
      // An unreadable report leaves the attempt's own findings.
    }
  }
  return {
    attempt: a.attempt,
    outcome: a.outcome ?? "",
    trigger: back?.trigger ?? null,
    reason: back?.reason ?? null,
    error: a.error_cause ? { cause: a.error_cause, reason: a.error_reason ?? "" } : null,
    blocking_findings: blocking,
    report_path: reportPath,
  };
}

export function matchAuthorization(
  db: Database,
  where: { worktreePath: string; repo: string; branch: string },
  now: number = Date.now(),
): AuthorizationMatch {
  const run = db
    .prepare("SELECT * FROM factory_runs WHERE worktree_path = ? AND state != 'closed' ORDER BY started_at DESC LIMIT 1")
    .get(where.worktreePath) as RunRow | undefined;
  if (!run) return noMatch("no_run");

  const reasons: AuthReason[] = [];
  if (run.repo !== where.repo) reasons.push("repo_mismatch");
  if (run.branch !== where.branch) reasons.push("branch_mismatch");
  if (!MATCHABLE.includes(run.state)) reasons.push("run_halted");
  if (deadlinePassed(run, now)) reasons.push("run_deadline");

  const auth = activeAuthorization(db, run.run_id);
  const contractPath = join(run.artifact_dir, "contract.json");
  if (!auth) {
    reasons.push("no_active_authorization");
  } else if (!existsSync(contractPath)) {
    reasons.push("contract_missing");
  } else {
    const digest = contractDigest(readFileSync(contractPath));
    if (digest !== auth.contract_digest || digest !== run.contract_digest) reasons.push("contract_changed");
  }
  if (reasons.length > 0) return { matched: false, reasons, run_id: run.run_id, state: run.state };

  const latest =
    (db
      .prepare(
        "SELECT attempt, status, outcome, head_sha FROM factory_attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1",
      )
      .get(run.run_id) as LatestAttempt | undefined) ?? null;
  return {
    matched: true,
    reasons: [],
    run_id: run.run_id,
    state: run.state,
    repo: run.repo,
    branch: run.branch,
    target_ref: run.target_ref,
    worktree_path: run.worktree_path,
    artifact_dir: run.artifact_dir,
    contract_path: contractPath,
    contract_digest: auth!.contract_digest,
    authorizes: JSON.parse(auth!.authorizes_json),
    approved_at: auth!.approved_at,
    deadline_at: run.deadline_at,
    issue_number: run.issue_number,
    pr_number: run.pr_number,
    latest_attempt: latest,
    next: nextStep(run.state, latest, run.state === "pr_open" && prShowsCurrentReport(db, run)),
    fix: fixHandoff(db, run),
    reentry: reentrySummary(db, run.run_id),
  };
}
