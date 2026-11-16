import type { Database } from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { activeAuthorization, contractDigest, deadlinePassed } from "./runs.ts";
import type { RunRow, RunState } from "./state.ts";

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
export type NextStep = "implement" | "resume" | "review" | "pr" | "refresh_pr";

export type LatestAttempt = { attempt: number; status: string; outcome: string | null; head_sha: string };

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
    };

const MATCHABLE: readonly RunState[] = ["approved", "implementing", "validating", "validated", "pr_open"];

export function noMatch(reason: AuthReason, run: RunRow | null = null): AuthorizationMatch {
  return { matched: false, reasons: [reason], run_id: run?.run_id ?? null, state: run?.state ?? null };
}

export function nextStep(state: RunState, latest: LatestAttempt | null): NextStep {
  if (latest && (latest.status === "awaiting_review" || latest.status === "finalizing")) return "review";
  if (latest && latest.status === "checks_running") return "resume";
  if (state === "validated") return "pr";
  if (state === "pr_open") return "refresh_pr";
  return "implement";
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
    next: nextStep(run.state, latest),
  };
}
