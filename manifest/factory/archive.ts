import type { Database } from "better-sqlite3";
import { resolve } from "node:path";
import { FactoryError, blocked } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunState } from "./state.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { agentToken, assertTokenHost, ghJson, remoteOf } from "./github.ts";
import type { Owner } from "./owner.ts";
import { reentries, type Reentry } from "./reentry.ts";

/**
 * `factory archive <run_id> --path <dir> [--close] [--abandon]`: record
 * where the host archived the run's artifacts (`archive_path`) and,
 * optionally, close the run so its worktree can start another.
 *
 * Closing takes its action from the run's PR, read as the agent:
 * - merged → `merged`;
 * - closed without merging, or no PR at all → `abandoned`;
 * - still open → refused (`pr_open`) unless `--abandon`, which closes the
 *   run as `abandoned` without asking GitHub.
 *
 * Closing also records what the operator did with the PR (§7.1, §7.4,
 * #110), in `operator_action` and as an `operator_action` event, so the
 * gate's recommendations can later be judged against it:
 * - merged, with no changes-requested review and the PR's head still the
 *   last validated head → `merged_as_is`;
 * - merged otherwise (a changes-requested review, or commits pushed after
 *   the validated head) → `changes_requested`;
 * - closed unmerged after a changes-requested review → `rejected`;
 * - closed unmerged otherwise, no PR, or `--abandon` → `abandoned`.
 * What this can't see: a review dismissed afterwards (DISMISSED doesn't
 * count); a review by the agent itself, which GitHub only allows as
 * COMMENTED on its own PR, so its change requests show only if the head
 * moves; and an "Update branch" merge from the base, which moves the head
 * and so reads as changes_requested. A head that can't be compared (no
 * validated attempt) counts as moved.
 * A re-entered run that merged (one `factory continue` took back to
 * implementing after its PR opened, #97) is `changes_requested` too, even
 * with no such review and its head the validated one: the PR as first
 * validated and recommended wasn't merged as is, so the §7.4 record must
 * count it. The event lists each re-entry (trigger, the gate's
 * recommendation then, the attempt and head it left from). A re-entered
 * run closed unmerged is rejected or abandoned as any other.
 *
 * The close action passed to the run's state change stays merged or
 * abandoned, as before. The artifact dir stays where it is (the database
 * holds its paths). The merge commit is recorded later (manifest-sync).
 * Bookkeeping: it works past the deadline, under the worktree lock, so it
 * waits for a live operation to finish.
 */

export const OPERATOR_ACTIONS = ["merged_as_is", "changes_requested", "rejected", "abandoned"] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

type PrView = {
  state: string;
  mergedAt: string | null;
  headRefOid?: string | null;
  reviews?: { state?: string; author?: { login?: string } | null }[] | null;
};

/** What the operator did, from the PR as GitHub reports it and the head the run last validated. */
export function operatorAction(
  pr: PrView,
  validatedHead: string | null,
  reentered: readonly Pick<Reentry, "trigger">[] = [],
): { action: OperatorAction; changesRequestedBy: string[] } {
  const changesRequestedBy = [
    ...new Set((pr.reviews ?? []).filter((v) => v.state === "CHANGES_REQUESTED").map((v) => v.author?.login ?? "unknown")),
  ];
  const merged = pr.state === "MERGED" || Boolean(pr.mergedAt);
  if (merged) {
    const headKept = validatedHead !== null && !!pr.headRefOid && pr.headRefOid === validatedHead;
    const asIs = changesRequestedBy.length === 0 && headKept && reentered.length === 0;
    return { action: asIs ? "merged_as_is" : "changes_requested", changesRequestedBy };
  }
  return { action: changesRequestedBy.length ? "rejected" : "abandoned", changesRequestedBy };
}

export type ArchiveResult = {
  run_id: string;
  archive_path: string;
  changed: boolean;
  closed: "merged" | "abandoned" | null;
  /** What the operator did, recorded when this call closed the run (#110); null otherwise. */
  operator_action: OperatorAction | null;
  pr_state: string | null;
  state: RunState;
};

/** The head the run last validated: its latest complete attempt's. */
function validatedHead(db: Database, runId: string): string | null {
  const row = db
    .prepare("SELECT head_sha FROM factory_attempts WHERE run_id = ? AND status = 'complete' ORDER BY attempt DESC LIMIT 1")
    .get(runId) as { head_sha: string } | undefined;
  return row?.head_sha ?? null;
}

export async function archiveRun(
  db: Database,
  runId: string,
  opts: { path: string; close?: boolean; abandon?: boolean; owner: Owner; lockWaitMs: number; env?: NodeJS.ProcessEnv },
): Promise<ArchiveResult> {
  if (!opts.path.trim()) throw new FactoryError("usage", "archive needs --path <dir>");
  const archivePath = resolve(opts.path);
  const close = Boolean(opts.close || opts.abandon);
  const run0 = getRun(db, runId);
  return withLocks(db, [worktreeLock(run0.worktree_path)], opts.owner, { waitMs: opts.lockWaitMs, runId }, () => {
    const run = getRun(db, runId);
    let action: "merged" | "abandoned" | null = null;
    let prState: string | null = null;
    let detail: { action: OperatorAction; changesRequestedBy: string[]; finalHead: string | null } | null = null;
    if (close && run.state !== "closed") {
      if (opts.abandon) {
        action = "abandoned";
      } else if (run.pr_number === null) {
        action = "abandoned";
      } else {
        const env = opts.env ?? process.env;
        const remote = remoteOf(run.worktree_path, run.repo);
        // Reading the PR carries the agent token: never to a host but github.com (#87).
        assertTokenHost(remote);
        const pr = ghJson<PrView>(
          ["pr", "view", String(run.pr_number), "-R", remote.ghRepo, "--json", "state,mergedAt,headRefOid,reviews"],
          { token: agentToken(env), env },
        );
        prState = pr.state;
        if (pr.state === "MERGED" || pr.mergedAt) action = "merged";
        else if (pr.state === "CLOSED") action = "abandoned";
        else throw blocked("pr_open", `PR #${run.pr_number} is still open; merge or close it first, or pass --abandon`);
        detail = { ...operatorAction(pr, validatedHead(db, runId), reentries(db, runId)), finalHead: pr.headRefOid ?? null };
      }
      if (!detail) detail = { action: "abandoned", changesRequestedBy: [], finalHead: null };
    }
    const changed = run.archive_path !== archivePath || action !== null;
    const updated = tx(db, () => {
      if (run.archive_path !== archivePath) {
        db.prepare("UPDATE factory_runs SET archive_path = ? WHERE run_id = ?").run(archivePath, runId);
        recordEvent(db, runId, "state_change", { entity: "archive", to: archivePath, previous: run.archive_path, owner: opts.owner });
      }
      if (!action || !detail) return getRun(db, runId);
      transitionRun(db, runId, "closed", { action, owner: opts.owner, reason: prState ? `PR #${run.pr_number} ${prState.toLowerCase()}` : "archived" });
      // The close action (merged, abandoned) goes on the state change; the
      // column keeps the richer record of what the operator did.
      db.prepare("UPDATE factory_runs SET operator_action = ? WHERE run_id = ?").run(detail.action, runId);
      recordEvent(db, runId, "operator_action", {
        action: detail.action,
        pr_number: run.pr_number,
        pr_state: prState,
        changes_requested_by: detail.changesRequestedBy,
        validated_head: validatedHead(db, runId),
        final_head: detail.finalHead,
        gate_recommendation: run.gate_recommendation ?? null,
        reentries: reentries(db, runId).map((r) => ({
          trigger: r.trigger,
          gate_recommendation: r.gate_recommendation,
          attempt: r.attempt,
          head_sha: r.head_sha,
          at: r.at ?? null,
        })),
        owner: opts.owner,
      });
      return getRun(db, runId);
    });
    return {
      run_id: runId,
      archive_path: archivePath,
      changed,
      closed: action,
      operator_action: action && detail ? detail.action : null,
      pr_state: prState,
      state: updated.state,
    };
  });
}
