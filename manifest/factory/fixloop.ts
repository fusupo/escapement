import type { Database } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, blocked, nowIso } from "./util.ts";
import { tx, getRun, getAttempt, transitionRun, type AttemptError, type AttemptRow, type RunRow, type RunState } from "./state.ts";
import { activeAuthorization, contractDigest, deadlinePassed } from "./runs.ts";
import { readSettings } from "./settings.ts";
import { faultPoint } from "./fault.ts";
import { GIVEN_TRIGGERS, recordReentry, reentries, type GivenTrigger, type Reentry, type ReentryTrigger } from "./reentry.ts";
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

type Finding = { id: string; severity: string; detail?: string; evidence_digest?: string; evidence_type?: string };

/**
 * A reviewer `judgment:{id}` finding on manual evidence: the reviewer judged
 * the procedure inadequate (`procedure_adequate: no`). Its instructions are
 * in the approved contract, which the implementer can't change, so another
 * attempt can only hit the same rejection (#99). A judgment on test or
 * command evidence, and one recorded before findings carried
 * `evidence_type`, is the implementer's to fix.
 */
function rejectedProcedure(f: Finding): boolean {
  return f.id.startsWith("judgment:") && f.evidence_type === "manual";
}

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

/**
 * The run's attempt budget: an explicit override, else the `max_attempts`
 * fixed at its first approval, else (a run approved before migration 3)
 * its worktree's `max-attempts` setting.
 */
export function attemptBudget(run: RunRow, override?: number): number {
  return override ?? run.max_attempts ?? readSettings(run.worktree_path).settings.maxAttempts;
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
 * 6. The attempt budget used up (interrupted attempts count) → escalated
 *    (`attempt_budget`). The budget is the run's `max_attempts`, fixed at
 *    approval (`attemptBudget`).
 * 7. A blocking finding that needs the operator's judgment → escalated
 *    (`needs_operator`): a refused sign-off, an unjustified assertion, or a
 *    rejected manual procedure (a re-approved contract is the only fix).
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
  const max = attemptBudget(run, opts.maxAttempts);
  if (used >= max) return escalate(`attempt_budget: ${used} of ${max} attempts used`);

  const blocking = blockingFindings(a);
  const operator = blocking.filter((f) => OPERATOR_FINDINGS.some((p) => f.id.startsWith(p)) || rejectedProcedure(f)).map((f) => f.id);
  if (operator.length) {
    const contract = blocking.some(rejectedProcedure) ? " (a rejected manual procedure: only a re-approved contract can change it)" : "";
    return escalate(`needs_operator: ${operator.join(", ")}${contract}`);
  }

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

// ── continue: the operator's way back (#92, #97) ─────────────────────

export type ContinueResult = {
  run: RunRow;
  /** False when the run was already back in implementing after this attempt. */
  changed: boolean;
  /** The latest attempt: the failed or errored one to fix, or (pr_open) the one the PR shows. */
  attempt: number;
  outcome: string;
  error: AttemptError | null;
  attempts_used: number;
  max_attempts: number;
  /** For a run with a PR (#97): the re-entry recorded for this attempt; null otherwise. */
  reentry: Reentry | null;
};

function latestAttempt(db: Database, runId: string): AttemptRow | null {
  return (
    (db.prepare("SELECT * FROM factory_attempts WHERE run_id = ? ORDER BY attempt DESC LIMIT 1").get(runId) as AttemptRow | undefined) ??
    null
  );
}

/** Did a human record a manual check of `attempt` (at its head) as failed? */
function manualCheckFailed(db: Database, runId: string, attempt: AttemptRow): boolean {
  const rows = db
    .prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'manual_outcome' ORDER BY id")
    .all(runId) as { detail_json: string }[];
  return rows.some((r) => {
    const d = JSON.parse(r.detail_json) as { attempt?: number; head_sha?: string; outcome?: string };
    return d.attempt === attempt.attempt && d.outcome === "fail" && (d.head_sha === undefined || d.head_sha === attempt.head_sha);
  });
}

/**
 * The budget a run with a PR gets again on re-entry (#97), when the
 * operator gives none: the one fixed at first approval, never the branch's
 * current `run-budget` setting (a commit to the branch can't buy the run
 * more time, as for the deadline and the attempt budget, #92). It is the
 * first re-entry's recorded budget, else the first approval's deadline
 * minus the time of the run's first authorization.
 */
function approvedBudgetMs(db: Database, run: RunRow): number | null {
  const first = reentries(db, run.run_id).find((r) => typeof r.run_budget_ms === "number");
  if (first) return first.run_budget_ms;
  if (!run.deadline_at) return null;
  const auth = db
    .prepare(
      `SELECT created_at FROM factory_events WHERE run_id = ? AND kind = 'state_change'
         AND json_extract(detail_json, '$.entity') = 'authorization' AND json_extract(detail_json, '$.to') = 'active'
       ORDER BY id LIMIT 1`,
    )
    .get(run.run_id) as { created_at: string } | undefined;
  if (!auth) return null;
  const ms = Date.parse(run.deadline_at) - Date.parse(auth.created_at);
  if (!(ms > 0)) return null;
  // The deadline and the event are written a moment apart: round to the second.
  return Math.round(ms / 1000) * 1000;
}

/**
 * `factory continue <run_id> --reason …` (§6.2, #92; §4.7, #97): the
 * operator takes a run back to implementing, under the same contract,
 * digest and authorization. The next validation is a new attempt, and the
 * attempt budget is never reset or raised. It takes:
 *
 * - an escalated run whose latest attempt is a completed `fail` or `error`
 *   (any `error` cause: the operator judges whether the environment is
 *   fixed);
 * - a run with a PR (#97), so the fix lands on the open PR: a `pr_open`
 *   run, on the operator's request (`--trigger review_finding` or
 *   `operator_request`, the default), or an escalated one as above, whose
 *   trigger is derived (`manual_check_failed` when a human recorded a
 *   manual check of that attempt as failed, else `attempt_failed`).
 *   Review and manual checks usually come after the run's deadline, so a
 *   run with a PR gets a new deadline: now plus `opts.budgetMs` (the
 *   operator's `--run-budget`), else the budget fixed at approval. A run
 *   with no deadline keeps none. Each re-entry is recorded (reentry.ts), in
 *   the same transaction.
 *
 * Refused, in this order:
 * - a closed run (`run_closed`); a run already back in implementing after
 *   this attempt is answered as it is (`changed: false`), before anything
 *   else, so a retry after a crash succeeds;
 * - any state but escalated or pr_open (`wrong_state`): a blocked run, or
 *   a validated one, whose PR is refreshed first;
 * - `--trigger` on any run but a pr_open one, or an unknown trigger (`usage`);
 * - `--run-budget` on a run with no PR (`usage`, #120): only a re-entry on
 *   an open PR gets a new deadline, so it would be silently ignored;
 * - a run with no PR past its deadline (`run_deadline`): a hard stop;
 * - no active authorization (`not_authorized`), or a contract file that no
 *   longer matches it (`contract_mismatch`);
 * - an escalated run whose latest attempt isn't a completed `fail` or
 *   `error` (`no_failed_attempt`): there's nothing to fix;
 * - every attempt used (`attempt_budget`).
 */
export function continueRun(
  db: Database,
  runId: string,
  opts: { reason: string; owner?: Owner; now?: number; maxAttempts?: number; trigger?: string; budgetMs?: number },
): ContinueResult {
  const why = opts.reason.trim();
  if (!why) throw new FactoryError("usage", "continue needs a --reason");
  const result = tx(db, () => {
    const run = getRun(db, runId);
    if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
    const latest = latestAttempt(db, runId);
    const failed = latest !== null && latest.status === "complete" && (latest.outcome === "fail" || latest.outcome === "error");
    const used = attemptsUsed(db, runId);
    const max = attemptBudget(run, opts.maxAttempts);
    const reentryFor = (attempt: number) => reentries(db, runId).filter((r) => r.attempt === attempt).pop() ?? null;
    const answer = (r: RunRow, changed: boolean, reentry: Reentry | null): ContinueResult => ({
      run: r,
      changed,
      attempt: latest!.attempt,
      outcome: latest!.outcome!,
      error: latest!.error_cause ? { cause: latest!.error_cause, reason: latest!.error_reason ?? "" } : null,
      attempts_used: used,
      max_attempts: max,
      reentry,
    });
    if (run.state === "implementing" && latest !== null) {
      const back = reentryFor(latest.attempt);
      if (back || failed) return answer(run, false, back);
    }
    if (run.state !== "escalated" && run.state !== "pr_open") {
      throw new FactoryError("wrong_state", `run ${runId} is ${run.state}; only an escalated run, or one whose PR is open, can continue`);
    }
    if (opts.trigger !== undefined) {
      if (run.state !== "pr_open") {
        throw new FactoryError("usage", `--trigger is only for a run whose PR is open; run ${runId} is ${run.state}, and its trigger is worked out from its latest attempt`);
      }
      if (!(GIVEN_TRIGGERS as readonly string[]).includes(opts.trigger)) {
        throw new FactoryError("usage", `--trigger must be one of: ${GIVEN_TRIGGERS.join(", ")}`);
      }
    }
    const hasPr = run.pr_number !== null;
    if (opts.budgetMs !== undefined && !hasPr) {
      throw new FactoryError("usage", `--run-budget is only for a run that has a PR (it sets the deadline of a re-entry on the PR); run ${runId} has none`);
    }
    if (!hasPr && deadlinePassed(run, opts.now)) {
      throw blocked("run_deadline", `run ${runId} passed its deadline (${run.deadline_at}); going on needs a new run and budget`);
    }
    const auth = activeAuthorization(db, runId);
    if (!auth) throw blocked("not_authorized", `run ${runId} has no active authorization`);
    let content: Buffer;
    try {
      content = readFileSync(join(run.artifact_dir, "contract.json"));
    } catch {
      throw blocked("contract_mismatch", `run ${runId}'s approved contract is missing`);
    }
    if (contractDigest(content) !== auth.contract_digest) {
      throw blocked("contract_mismatch", `run ${runId}'s contract no longer matches the approved one (${auth.contract_digest}); re-approve it`);
    }
    if (run.state === "escalated" && !failed) {
      const what = latest ? `attempt ${latest.attempt} is ${latest.status}${latest.outcome ? ` (${latest.outcome})` : ""}` : "it has no attempt";
      throw blocked("no_failed_attempt", `run ${runId} can't continue: ${what}; continue takes a run back after a failed or errored attempt`);
    }
    if (latest === null) {
      throw blocked("no_failed_attempt", `run ${runId} can't continue: it has no attempt`);
    }
    if (used >= max) {
      throw blocked("attempt_budget", `run ${runId} has used all ${max} attempts; going on needs a new run`);
    }
    if (!hasPr) {
      return answer(transitionRun(db, runId, FIX_LOOP, { reason: `continue: ${why}`, owner: opts.owner }), true, null);
    }

    const trigger: ReentryTrigger =
      run.state === "pr_open"
        ? ((opts.trigger as GivenTrigger | undefined) ?? "operator_request")
        : manualCheckFailed(db, runId, latest)
          ? "manual_check_failed"
          : "attempt_failed";
    const budget = opts.budgetMs ?? approvedBudgetMs(db, run);
    if (run.deadline_at !== null && budget === null) {
      throw new FactoryError("usage", `run ${runId}'s approved budget can't be worked out; pass --run-budget`);
    }
    const now = opts.now ?? Date.now();
    const deadline = run.deadline_at === null || budget === null ? null : nowIso(new Date(now + budget));
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(deadline, runId);
    const reentry: Reentry = {
      trigger,
      reason: why,
      pr_number: run.pr_number!,
      from_state: run.state,
      attempt: latest.attempt,
      head_sha: latest.head_sha,
      outcome: latest.outcome,
      gate_recommendation: run.gate_recommendation ?? null,
      gate_reasons: run.gate_reasons_json ? (JSON.parse(run.gate_reasons_json) as string[]) : [],
      previous_deadline: run.deadline_at,
      deadline,
      run_budget_ms: deadline === null ? null : budget,
      owner: opts.owner ?? null,
    };
    recordReentry(db, runId, reentry);
    const moved = transitionRun(db, runId, FIX_LOOP, { reason: `continue (${trigger}, PR #${run.pr_number}): ${why}`, owner: opts.owner });
    return answer(moved, true, reentryFor(latest.attempt));
  });
  if (result.changed) faultPoint("continue.committed");
  return result;
}
