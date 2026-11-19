import type { Database } from "better-sqlite3";
import { recordEvent } from "./state.ts";
import type { Owner } from "./owner.ts";

/**
 * Re-entry after the PR is open (docs/FACTORY_DESIGN.md §4.7, #97): the
 * operator's `factory continue` takes a run that already has a PR back to
 * implementing, so the fix lands on the same PR.
 *
 * Each re-entry is recorded as a `state_change` event with
 * `entity: "reentry"`, written in the same transaction as the run's move
 * back to implementing. The gate (a re-entered run always gets `ping`) and
 * `archive --close` (a re-entered run that merged is `changes_requested`)
 * read these events, so they keep the recommendation the run left from
 * even after `factory pr` overwrites the run's latest one. No migration:
 * `state_change` is an allowed event kind.
 */

/**
 * Why a run with a PR went back to implementation:
 * - `review_finding`: a finding on the open PR (given by the operator);
 * - `operator_request`: any other change the operator asks for (given; the default);
 * - `manual_check_failed`: a human recorded a manual check as failed (derived);
 * - `attempt_failed`: a later attempt failed or errored and the run escalated (derived).
 */
export const REENTRY_TRIGGERS = ["review_finding", "operator_request", "manual_check_failed", "attempt_failed"] as const;
export type ReentryTrigger = (typeof REENTRY_TRIGGERS)[number];

/** The triggers the operator gives with `--trigger`, only for a `pr_open` run; the others are derived. */
export const GIVEN_TRIGGERS = ["review_finding", "operator_request"] as const satisfies readonly ReentryTrigger[];
export type GivenTrigger = (typeof GIVEN_TRIGGERS)[number];

export type Reentry = {
  trigger: ReentryTrigger;
  /** The operator's words (`--reason`). */
  reason: string;
  pr_number: number;
  /** The run state it left: `pr_open` or `escalated`. */
  from_state: string;
  /** The latest attempt when it left, and that attempt's head and outcome. */
  attempt: number;
  head_sha: string;
  outcome: string | null;
  /** The gate's recommendation and reasons at that point (the run's latest). */
  gate_recommendation: string | null;
  gate_reasons: string[];
  previous_deadline: string | null;
  deadline: string | null;
  /** The budget the new deadline was set from: the operator's `--run-budget`, else the one fixed at approval. */
  run_budget_ms: number | null;
  owner?: Owner | null;
  /** When it was recorded (the event's time). */
  at?: string;
};

export function recordReentry(db: Database, runId: string, r: Reentry): void {
  recordEvent(db, runId, "state_change", { entity: "reentry", ...r, owner: r.owner ?? null });
}

/** Every re-entry of the run, oldest first. */
export function reentries(db: Database, runId: string): Reentry[] {
  const rows = db
    .prepare(
      `SELECT detail_json, created_at FROM factory_events
        WHERE run_id = ? AND kind = 'state_change' AND json_extract(detail_json, '$.entity') = 'reentry'
        ORDER BY id`,
    )
    .all(runId) as { detail_json: string; created_at: string }[];
  return rows.map((row) => {
    const { entity: _entity, ...detail } = JSON.parse(row.detail_json) as Reentry & { entity: string };
    return { ...detail, at: row.created_at };
  });
}

export function latestReentry(db: Database, runId: string): Reentry | null {
  const all = reentries(db, runId);
  return all.length ? all[all.length - 1] : null;
}

/** The short summary `factory authorization` and the gate show for a re-entered run. */
export type ReentrySummary = { count: number; trigger: ReentryTrigger; attempt: number; reason: string; pr_number: number };

export function reentrySummary(db: Database, runId: string): ReentrySummary | null {
  const all = reentries(db, runId);
  if (!all.length) return null;
  const last = all[all.length - 1];
  return { count: all.length, trigger: last.trigger, attempt: last.attempt, reason: last.reason, pr_number: last.pr_number };
}
