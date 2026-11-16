import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { identityHolds } from "./revision.ts";
import { tx, getRun, transitionRun, transitionAttempt, type AttemptRow, type RunRow, type RunState } from "./state.ts";
import { deadlinePassed } from "./runs.ts";
import { withLocks, listLocks, worktreeLock, BUILD_LOCK } from "./locks.ts";
import { isAlive, parseOwner, type Owner } from "./owner.ts";
import { verdictPath } from "./attempts.ts";
import { reviewDir } from "./review.ts";
import { join } from "node:path";

/**
 * What `resume` found for an attempt and did about it (§4.7):
 *
 * | found                               | action            |
 * |-------------------------------------|-------------------|
 * | checks_running, owner dead          | interrupted       |
 * | checks_running, owner alive         | running (no change) |
 * | awaiting_review, no verdict         | reissue_review    |
 * | awaiting_review, verdict file       | record_review     |
 * | awaiting_review, identity changed   | identity_error (attempt complete, outcome error) |
 * | finalizing, verdict file            | refinalize        |
 * | finalizing, no verdict file         | needs_attention   |
 * | complete, run still validating      | advanced_run      |
 *
 * `reissue_review`, `record_review` and `refinalize` are next steps for the
 * caller, and `detail` names the command: `factory review-input`, or
 * `factory record-review` with the verdict file. Resume itself never starts
 * checks or records a verdict.
 */
export type ResumeAction = {
  attempt: number;
  found: string;
  action:
    | "interrupted"
    | "running"
    | "reissue_review"
    | "record_review"
    | "identity_error"
    | "refinalize"
    | "needs_attention"
    | "advanced_run";
  detail?: string;
};

export type ResumeResult = {
  run: RunRow;
  deadline_passed: boolean;
  actions: ResumeAction[];
  /** Locks for this run's worktree (or the build lock) whose holder had died, now removed. */
  released_locks: string[];
};

/**
 * Run transition owed once an attempt completes with this outcome (first
 * release: no fix loop). `pending_manual` is validated too: the PR can open
 * while a human records the manual outcomes (§5.5).
 */
export function runStateForOutcome(outcome: string | null): RunState {
  if (outcome === "pass" || outcome === "pending_manual") return "validated";
  if (outcome === "blocked") return "blocked";
  return "escalated";
}

function ownerAlive(a: AttemptRow): boolean {
  const owner = parseOwner(a.owner_json);
  return owner !== null && isAlive(owner);
}

/**
 * Reconcile an interrupted run. Holds the run's worktree lock, so it waits
 * for (or is blocked by) a live operation on the same worktree. Works past
 * the run deadline, but then only reconciles: it escalates the run and
 * starts nothing. Budgets are never reset.
 */
export async function resumeRun(
  db: Database,
  runId: string,
  opts: { owner: Owner; lockWaitMs: number },
): Promise<ResumeResult> {
  const run = getRun(db, runId);
  const released = releaseDeadLocks(db, run);
  return withLocks(db, [worktreeLock(run.worktree_path)], opts.owner, { waitMs: opts.lockWaitMs, runId }, () => {
    const actions: ResumeAction[] = [];
    const attempts = db
      .prepare("SELECT * FROM factory_attempts WHERE run_id = ? ORDER BY attempt")
      .all(runId) as AttemptRow[];

    for (const a of attempts) {
      const stored = verdictPath(run.artifact_dir, a.attempt);
      const verdict = existsSync(stored);
      // A verdict the reviewer wrote where the bundle asked, not yet recorded.
      const written = join(reviewDir(run.artifact_dir, a.attempt), "verdict.json");
      const record = (file: string) => `factory record-review ${runId} ${a.attempt} ${file}`;
      if (a.status === "checks_running") {
        if (ownerAlive(a)) {
          actions.push({ attempt: a.attempt, found: a.status, action: "running" });
        } else {
          transitionAttempt(db, runId, a.attempt, "interrupted", { owner: null, reason: "owner_dead" });
          actions.push({ attempt: a.attempt, found: a.status, action: "interrupted", detail: "checks owner is not running" });
        }
      } else if (a.status === "awaiting_review") {
        const id = identityHolds(run.worktree_path, a.head_sha);
        if (!id.ok) {
          transitionAttempt(db, runId, a.attempt, "complete", {
            owner: null,
            outcome: "error",
            reason: "revision changed during validation",
          });
          actions.push({ attempt: a.attempt, found: a.status, action: "identity_error", detail: id.detail });
        } else {
          const file = verdict ? stored : existsSync(written) ? written : null;
          actions.push(
            file
              ? { attempt: a.attempt, found: a.status, action: "record_review", detail: record(file) }
              : { attempt: a.attempt, found: a.status, action: "reissue_review", detail: `factory review-input ${runId} ${a.attempt}` },
          );
        }
      } else if (a.status === "finalizing") {
        if (ownerAlive(a)) {
          actions.push({ attempt: a.attempt, found: a.status, action: "running" });
        } else {
          actions.push({
            attempt: a.attempt,
            found: a.status,
            action: verdict ? "refinalize" : "needs_attention",
            detail: verdict ? record(stored) : "finalizing without a verdict file",
          });
        }
      }
    }

    // A completed latest attempt whose run transition never happened.
    const last = attempts.at(-1);
    const current = getRun(db, runId);
    if (last && current.state === "validating") {
      const latest = db
        .prepare("SELECT * FROM factory_attempts WHERE run_id = ? AND attempt = ?")
        .get(runId, last.attempt) as AttemptRow;
      if (latest.status === "complete") {
        const to = runStateForOutcome(latest.outcome);
        transitionRun(db, runId, to, { owner: opts.owner, reason: `attempt ${latest.attempt}: ${latest.outcome ?? "no outcome"}` });
        actions.push({ attempt: latest.attempt, found: "complete", action: "advanced_run", detail: `validating → ${to}` });
      }
    }

    const passed = deadlinePassed(getRun(db, runId));
    const now = getRun(db, runId);
    if (passed && now.state !== "closed" && now.state !== "escalated") {
      transitionRun(db, runId, "escalated", { owner: opts.owner, reason: "run_deadline" });
    }
    return { run: getRun(db, runId), deadline_passed: passed, actions, released_locks: released };
  });
}

/** Remove the run's worktree lock and the build lock when their holders have died. */
function releaseDeadLocks(db: Database, run: RunRow): string[] {
  const names = [worktreeLock(run.worktree_path), BUILD_LOCK];
  return tx(db, () =>
    listLocks(db)
      .filter((l) => names.includes(l.name) && !l.alive)
      .map((l) => {
        db.prepare("DELETE FROM factory_locks WHERE name = ?").run(l.name);
        return l.name;
      }),
  );
}
