import type { Database } from "better-sqlite3";
import { FactoryError, nowIso } from "./util.ts";
import type { Owner } from "./owner.ts";

// ── Run states (§4.7) ────────────────────────────────────────────────

export const RUN_STATES = [
  "planned",
  "approved",
  "implementing",
  "validating",
  "validated",
  "pr_open",
  "closed",
  "blocked",
  "escalated",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** `closed` is the only terminal state; `blocked` and `escalated` wait on a human. */
export const TERMINAL_RUN_STATES: readonly RunState[] = ["closed"];

const HALT: RunState[] = ["blocked", "escalated", "closed"];

/**
 * Allowed run transitions. Every non-terminal state may halt (blocked,
 * escalated) or be closed. The fix loop (§6.2, #92) adds two ways back to
 * implementation, both under the same contract and authorization:
 *
 * - validating → implementing: the runner's own decision after an attempt
 *   the implementer can fix (fixloop.ts `decideAfterAttempt`);
 * - escalated → implementing: the operator's `factory continue`.
 *
 * Re-entry after the PR is open (#97) adds a third, also the operator's
 * `factory continue`: pr_open → implementing, for a fix that belongs on the
 * open PR. A validated run still has no way back: its PR is refreshed first.
 *
 * A blocked run can only be closed.
 */
export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
  planned: ["approved", ...HALT],
  approved: ["implementing", ...HALT],
  implementing: ["validating", ...HALT],
  validating: ["validated", "implementing", ...HALT],
  validated: ["pr_open", ...HALT],
  pr_open: ["implementing", "closed", "blocked", "escalated"],
  blocked: ["closed"],
  escalated: ["implementing", "closed"],
  closed: [],
};

export const CLOSE_ACTIONS = ["merged", "rejected", "abandoned"] as const;

// ── Attempt states (§4.7) ────────────────────────────────────────────

export const ATTEMPT_STATES = ["checks_running", "awaiting_review", "finalizing", "complete", "interrupted"] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  // Deterministic failure, blocked or error completes without review.
  checks_running: ["awaiting_review", "complete", "interrupted"],
  // complete: identity check failed before review (outcome error).
  awaiting_review: ["finalizing", "complete", "interrupted"],
  finalizing: ["complete", "interrupted"],
  complete: [],
  interrupted: [],
};

// ── Transactions and events ──────────────────────────────────────────

/**
 * Run `fn` in an IMMEDIATE transaction, or inside the caller's transaction
 * if one is open. IMMEDIATE takes SQLite's write lock up front, so
 * concurrent factory processes serialize and each re-reads current state.
 */
export function tx<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}

export function recordEvent(db: Database, runId: string | null, kind: string, detail: unknown): void {
  db.prepare("INSERT INTO factory_events (run_id, kind, detail_json, created_at) VALUES (?, ?, ?, ?)").run(
    runId,
    kind,
    JSON.stringify(detail),
    nowIso(),
  );
}

export type RunRow = {
  run_id: string;
  work_item: string;
  repo: string;
  worktree_path: string;
  branch: string;
  target_ref: string;
  artifact_dir: string;
  deadline_at: string | null;
  /** The attempt budget, fixed at first approval like the deadline (migration 3); null for older runs. */
  max_attempts?: number | null;
  issue_number: number | null;
  manifest_id: string | null;
  work_type: string | null;
  state: RunState;
  state_reason: string | null;
  tier_proposed: string | null;
  tier_actual: string | null;
  contract_digest: string | null;
  policy_version: string | null;
  /** The gate's latest recommendation and its reasons (JSON), set by `factory pr` (#110). */
  gate_recommendation?: string | null;
  gate_reasons_json?: string | null;
  operator_action: string | null;
  pr_number: number | null;
  merge_sha: string | null;
  archive_path: string | null;
  started_at: string;
  ended_at: string | null;
};

export function getRun(db: Database, runId: string): RunRow {
  const row = db.prepare("SELECT * FROM factory_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  if (!row) throw new FactoryError("no_such_run", `no run ${runId}`);
  return row;
}

/**
 * Move a run to `to`, recording a `state_change` event. Rejects edges not
 * in RUN_TRANSITIONS. When `from` is given, the run must currently be in
 * one of those states. Closing a run ends its active authorization (§3.6).
 */
export function transitionRun(
  db: Database,
  runId: string,
  to: RunState,
  opts: { from?: readonly RunState[]; reason?: string; owner?: Owner; action?: string } = {},
): RunRow {
  return tx(db, () => {
    const run = getRun(db, runId);
    if (opts.from && !opts.from.includes(run.state)) {
      throw new FactoryError(
        "wrong_state",
        `run ${runId} is ${run.state}; expected ${opts.from.join(" or ")}`,
      );
    }
    if (!RUN_TRANSITIONS[run.state].includes(to)) {
      throw new FactoryError("illegal_transition", `run ${runId} cannot go from ${run.state} to ${to}`);
    }
    if (to === "closed") {
      if (!opts.action || !(CLOSE_ACTIONS as readonly string[]).includes(opts.action)) {
        throw new FactoryError("bad_close_action", `closing a run needs one of: ${CLOSE_ACTIONS.join(", ")}`);
      }
    }
    const now = nowIso();
    const terminal = TERMINAL_RUN_STATES.includes(to);
    db.prepare(
      `UPDATE factory_runs SET state = ?, state_reason = ?, ended_at = ?,
         operator_action = COALESCE(?, operator_action) WHERE run_id = ?`,
    ).run(to, opts.reason ?? null, terminal ? now : null, to === "closed" ? opts.action : null, runId);
    if (terminal) {
      db.prepare(
        "UPDATE factory_authorizations SET status = 'ended', ended_at = ? WHERE run_id = ? AND status = 'active'",
      ).run(now, runId);
    }
    recordEvent(db, runId, "state_change", {
      entity: "run",
      from: run.state,
      to,
      reason: opts.reason ?? null,
      action: opts.action ?? null,
      owner: opts.owner ?? null,
    });
    return getRun(db, runId);
  });
}

export type AttemptRow = {
  run_id: string;
  attempt: number;
  status: AttemptState;
  owner_json: string | null;
  verdict_digest: string | null;
  outcome: string | null;
  head_sha: string;
  contract_digest: string;
  policy_version: string;
  report_path: string | null;
  failed_phase?: string | null;
  findings_json?: string | null;
  flags_json?: string | null;
  /** Why an `error` attempt errored, and so who can fix it (migration 3, §5.4). */
  error_cause: ErrorCause | null;
  error_reason: string | null;
  started_at: string;
  ended_at: string | null;
};

/** Who can fix an `error` attempt (§5.4): the implementer (code, run) or only the operator (environment). */
export const ERROR_CAUSES = ["code", "run", "environment"] as const;
export type ErrorCause = (typeof ERROR_CAUSES)[number];
export type AttemptError = { cause: ErrorCause; reason: string };

export function getAttempt(db: Database, runId: string, attempt: number): AttemptRow {
  const row = db
    .prepare("SELECT * FROM factory_attempts WHERE run_id = ? AND attempt = ?")
    .get(runId, attempt) as AttemptRow | undefined;
  if (!row) throw new FactoryError("no_such_attempt", `no attempt ${attempt} for run ${runId}`);
  return row;
}

/**
 * Move an attempt to `to`, recording the owning operation and a
 * `state_change` event. `owner: null` clears the owner (no live operation).
 */
export function transitionAttempt(
  db: Database,
  runId: string,
  attempt: number,
  to: AttemptState,
  opts: { owner?: Owner | null; outcome?: string; reason?: string; error?: AttemptError } = {},
): AttemptRow {
  return tx(db, () => {
    const row = getAttempt(db, runId, attempt);
    if (!ATTEMPT_TRANSITIONS[row.status].includes(to)) {
      throw new FactoryError(
        "illegal_transition",
        `attempt ${attempt} of ${runId} cannot go from ${row.status} to ${to}`,
      );
    }
    const done = to === "complete" || to === "interrupted";
    const ownerJson = opts.owner === undefined ? row.owner_json : opts.owner ? JSON.stringify(opts.owner) : null;
    db.prepare(
      `UPDATE factory_attempts SET status = ?, owner_json = ?, outcome = COALESCE(?, outcome),
         error_cause = COALESCE(?, error_cause), error_reason = COALESCE(?, error_reason),
         ended_at = ? WHERE run_id = ? AND attempt = ?`,
    ).run(
      to,
      ownerJson,
      opts.outcome ?? null,
      opts.error?.cause ?? null,
      opts.error?.reason ?? null,
      done ? nowIso() : null,
      runId,
      attempt,
    );
    recordEvent(db, runId, "state_change", {
      entity: "attempt",
      attempt,
      from: row.status,
      to,
      reason: opts.reason ?? null,
      outcome: opts.outcome ?? null,
      ...(opts.error ? { error: opts.error } : {}),
      owner: opts.owner ?? null,
    });
    return getAttempt(db, runId, attempt);
  });
}
