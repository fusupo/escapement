import type { Database } from "better-sqlite3";
import { tx, getRun, getAttempt, transitionRun, type AttemptRow, type RunState } from "./state.ts";
import { deadlinePassed } from "./runs.ts";
import { readSettings } from "./settings.ts";
import type { Owner } from "./owner.ts";

/**
 * The bounded fix loop (docs/FACTORY_DESIGN.md §6.2, #92): what a run does
 * after an attempt completes.
 *
 * `decideAfterAttempt` is the one place that maps an attempt's outcome to
 * the run's next state. validate, review-input, record-review and resume
 * all apply it through `advanceRun`, so a crash between an attempt
 * completing and its run transition resolves exactly as the command that
 * crashed would have.
 */

export type Decision = { to: RunState; reason: string };

/** The run's next state after a non-passing attempt goes back to the implementer. */
export const FIX_LOOP = "implementing" satisfies RunState;

/**
 * Blocking findings that need the operator's judgment, never the
 * implementer's (§6.2): a sensitive-path or execution-policy sign-off the
 * reviewer refused, and a modified assertion the reviewer won't justify.
 */
const OPERATOR_FINDINGS = ["signoff:", "justification:"];

type Finding = { id: string; severity: string; detail?: string; evidence_digest?: string };

function blockingFindings(a: Pick<AttemptRow, "findings_json">): Finding[] {
  if (!a.findings_json) return [];
  try {
    return (JSON.parse(a.findings_json) as Finding[]).filter((f) => f.severity === "blocking");
  } catch {
    return [];
  }
}

/**
 * Blocking findings of this attempt that are unchanged since the attempt
 * before it (§6.2 "stuck"): the same ID with the same `evidence_digest`.
 * Only the runner's deterministic findings carry a digest of the failure
 * (checks and evidence). Reviewer findings are never compared: each
 * attempt's reviewer is fresh and words the same problem differently, so
 * they are bounded by `max-attempts` alone.
 */
export function stuckFindings(db: Database, runId: string, attempt: number): string[] {
  if (attempt < 2) return [];
  const prev = db.prepare("SELECT * FROM factory_attempts WHERE run_id = ? AND attempt = ?").get(runId, attempt - 1) as
    | AttemptRow
    | undefined;
  if (!prev || prev.status !== "complete") return [];
  const before = new Map(
    blockingFindings(prev)
      .filter((f) => f.evidence_digest && !f.id.startsWith("review:"))
      .map((f) => [f.id, f.evidence_digest]),
  );
  return blockingFindings(getAttempt(db, runId, attempt))
    .filter((f) => f.evidence_digest && !f.id.startsWith("review:") && before.get(f.id) === f.evidence_digest)
    .map((f) => f.id);
}

export function attemptsUsed(db: Database, runId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM factory_attempts WHERE run_id = ?").get(runId) as { n: number }).n;
}

/** The run's `max-attempts`, from its worktree's settings (the default when they can't be read). */
export function maxAttemptsFor(worktree: string): number {
  return readSettings(worktree).settings.maxAttempts;
}

/**
 * The run's next state after `attempt` completed, in order:
 *
 * 1. `pass` or `pending_manual` → validated.
 * 2. `blocked` → blocked.
 * 3. Anything but `fail` or `error` → escalated.
 * 4. The run deadline has passed → escalated (`run_deadline`).
 * 5. An `error` caused by the environment (or with no recorded cause) →
 *    escalated: attempts are never spent on a broken machine.
 * 6. `max-attempts` used up (interrupted attempts count) → escalated
 *    (`attempt_budget`).
 * 7. A blocking finding that needs the operator's judgment → escalated
 *    (`needs_operator`).
 * 8. A deterministic blocking finding unchanged since the last attempt →
 *    escalated (`stuck`).
 * 9. Otherwise → implementing: the fix loop goes again.
 */
export function decideAfterAttempt(
  db: Database,
  runId: string,
  attempt: number,
  opts: { now?: number; maxAttempts?: number } = {},
): Decision {
  const run = getRun(db, runId);
  const a = getAttempt(db, runId, attempt);
  const outcome = a.outcome;
  if (outcome === "pass" || outcome === "pending_manual") return { to: "validated", reason: `attempt ${attempt}: ${outcome}` };
  if (outcome === "blocked") return { to: "blocked", reason: `attempt ${attempt}: blocked` };
  if (outcome !== "fail" && outcome !== "error") return { to: "escalated", reason: `attempt ${attempt}: ${outcome ?? "no outcome"}` };

  const label = `attempt ${attempt}: ${outcome}${outcome === "error" ? ` (${a.error_cause ?? "environment"})` : ""}`;
  const escalate = (why: string): Decision => ({ to: "escalated", reason: `${label}; ${why}` });

  if (deadlinePassed(run, opts.now)) return escalate("run_deadline");
  if (outcome === "error" && a.error_cause !== "code" && a.error_cause !== "run") {
    return escalate(`needs the operator: ${a.error_reason ?? "an environment error"}`);
  }
  const used = attemptsUsed(db, runId);
  const max = opts.maxAttempts ?? maxAttemptsFor(run.worktree_path);
  if (used >= max) return escalate(`attempt_budget: ${used} of ${max} attempts used`);

  const operator = blockingFindings(a)
    .map((f) => f.id)
    .filter((id) => OPERATOR_FINDINGS.some((p) => id.startsWith(p)));
  if (operator.length) return escalate(`needs_operator: ${operator.join(", ")}`);

  const stuck = stuckFindings(db, runId, attempt);
  if (stuck.length) return escalate(`stuck: ${stuck.join(", ")} unchanged since attempt ${attempt - 1}`);

  return { to: FIX_LOOP, reason: `${label}; fix_loop: back to implementation (${used} of ${max} attempts used)` };
}

/**
 * Apply `decideAfterAttempt` to a run still `validating` after `attempt`
 * completed. Returns the decision, or null when the run had already moved
 * on (escalated meanwhile, for example), which is left as it is.
 */
export function advanceRun(
  db: Database,
  runId: string,
  attempt: number,
  opts: { owner?: Owner; now?: number; maxAttempts?: number } = {},
): Decision | null {
  return tx(db, () => {
    if (getRun(db, runId).state !== "validating") return null;
    const d = decideAfterAttempt(db, runId, attempt, opts);
    transitionRun(db, runId, d.to, { owner: opts.owner, reason: d.reason });
    return d;
  });
}
