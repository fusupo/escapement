import type { Database } from "better-sqlite3";
import { resolve } from "node:path";
import { FactoryError, blocked } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunState } from "./state.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { agentToken, assertTokenHost, ghJson, remoteOf } from "./github.ts";
import { mainRepoRoot, repoName } from "./context.ts";
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
 * A merged PR's merge commit (`mergeCommit.oid`, from the same `pr view`)
 * is recorded as the run's `merge_sha` and in the `operator_action` event
 * (#117), so a later revert or defect can be traced back to the run and
 * its gate recommendation. An abandoned run records none. Runs closed
 * before #117 are filled in by `backfillMergeShas`.
 *
 * The close action passed to the run's state change stays merged or
 * abandoned, as before. The artifact dir stays where it is (the database
 * holds its paths).
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
  mergeCommit?: { oid?: string | null } | null;
};

/** A merge commit's SHA from a PR view: a full 40-hex SHA, or null. */
function mergeShaOf(pr: Pick<PrView, "mergeCommit">): string | null {
  const oid = pr.mergeCommit?.oid ?? null;
  return oid && /^[0-9a-f]{40}$/.test(oid) ? oid : null;
}

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
  /** The PR's merge commit, recorded when this call closed the run as merged (#117); null otherwise. */
  merge_sha: string | null;
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
    let detail: { action: OperatorAction; changesRequestedBy: string[]; finalHead: string | null; mergeSha: string | null } | null = null;
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
          ["pr", "view", String(run.pr_number), "-R", remote.ghRepo, "--json", "state,mergedAt,headRefOid,reviews,mergeCommit"],
          { token: agentToken(env), env },
        );
        prState = pr.state;
        if (pr.state === "MERGED" || pr.mergedAt) action = "merged";
        else if (pr.state === "CLOSED") action = "abandoned";
        else throw blocked("pr_open", `PR #${run.pr_number} is still open; merge or close it first, or pass --abandon`);
        detail = {
          ...operatorAction(pr, validatedHead(db, runId), reentries(db, runId)),
          finalHead: pr.headRefOid ?? null,
          mergeSha: action === "merged" ? mergeShaOf(pr) : null,
        };
      }
      if (!detail) detail = { action: "abandoned", changesRequestedBy: [], finalHead: null, mergeSha: null };
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
      db.prepare("UPDATE factory_runs SET operator_action = ?, merge_sha = ? WHERE run_id = ?").run(detail.action, detail.mergeSha, runId);
      recordEvent(db, runId, "operator_action", {
        action: detail.action,
        pr_number: run.pr_number,
        pr_state: prState,
        changes_requested_by: detail.changesRequestedBy,
        validated_head: validatedHead(db, runId),
        final_head: detail.finalHead,
        merge_sha: detail.mergeSha,
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
      merge_sha: action && detail ? detail.mergeSha : null,
      pr_state: prState,
      state: updated.state,
    };
  });
}

// ── backfill-merge-shas (#117) ───────────────────────────────────────

/** Close actions that mean the PR merged: #110's two, and the plain `merged` runs closed before #110 hold. */
const MERGED_ACTIONS = ["merged_as_is", "changes_requested", "merged"] as const;

export type BackfillResult = {
  /** The repository whose runs were looked at, from the checkout the command ran in. */
  repo: string;
  filled: { run_id: string; pr_number: number; merge_sha: string }[];
  skipped: { run_id: string; pr_number: number; reason: string }[];
};

/**
 * `factory backfill-merge-shas [run_id]`: fill in `merge_sha` for runs
 * closed as merged before `archive --close` recorded it (#117).
 *
 * The repository is the checkout the command runs in (`worktree`, from the
 * cwd or --project-root), never a run's own `worktree_path`: an old run's
 * worktree is usually gone. Its runs that are closed, merged
 * (`operator_action` merged_as_is, changes_requested or the older merged),
 * have a PR and no merge SHA are looked up; `runId` narrows that to one.
 * origin's host is checked before any gh call, which carries the agent
 * token. A merged PR with a 40-hex merge commit gets its `merge_sha` and a
 * `state_change` event (entity `merge_sha`, source `backfill`); the
 * operator_action event recorded at close is left as it was. A PR that
 * isn't merged, or reports no merge commit, is skipped with the reason.
 * Idempotent: a run with a merge SHA is never looked at again.
 *
 * A gh lookup that fails stops the sweep at that run (#120). Each fill
 * commits on its own, so the ones already made are kept; the error keeps
 * gh's code and message and adds what the sweep didn't reach, in its
 * message and as `detail`: `filled` and `skipped` so far (shaped as in the
 * result), the `failed` run, and every run still `waiting` (the failed one
 * and each after it). Running it again looks up only those.
 */
export function backfillMergeShas(
  db: Database,
  opts: { worktree: string; runId?: string; owner: Owner; env?: NodeJS.ProcessEnv },
): BackfillResult {
  const repo = repoName(mainRepoRoot(opts.worktree));
  const rows = db
    .prepare(
      `SELECT run_id, pr_number FROM factory_runs
       WHERE repo = ? AND state = 'closed' AND pr_number IS NOT NULL AND merge_sha IS NULL
         AND operator_action IN (${MERGED_ACTIONS.map(() => "?").join(", ")})
         ${opts.runId ? "AND run_id = ?" : ""}
       ORDER BY started_at, run_id`,
    )
    .all(repo, ...MERGED_ACTIONS, ...(opts.runId ? [opts.runId] : [])) as { run_id: string; pr_number: number }[];
  const result: BackfillResult = { repo, filled: [], skipped: [] };
  if (rows.length === 0) return result;
  const remote = remoteOf(opts.worktree, repo);
  // Every lookup carries the agent token: never to a host but github.com (#87).
  assertTokenHost(remote);
  const env = opts.env ?? process.env;
  const token = agentToken(env);
  for (const [i, row] of rows.entries()) {
    let pr: PrView;
    try {
      pr = ghJson<PrView>(["pr", "view", String(row.pr_number), "-R", remote.ghRepo, "--json", "state,mergedAt,mergeCommit"], { token, env });
    } catch (err) {
      if (!(err instanceof FactoryError)) throw err;
      throw backfillStopped(err, result, row, rows.slice(i));
    }
    const merged = pr.state === "MERGED" || Boolean(pr.mergedAt);
    const sha = merged ? mergeShaOf(pr) : null;
    if (!merged) {
      result.skipped.push({ run_id: row.run_id, pr_number: row.pr_number, reason: `PR #${row.pr_number} is ${pr.state.toLowerCase()}, not merged` });
      continue;
    }
    if (!sha) {
      result.skipped.push({ run_id: row.run_id, pr_number: row.pr_number, reason: `PR #${row.pr_number} reports no merge commit` });
      continue;
    }
    const wrote = tx(db, () => {
      const changes = db.prepare("UPDATE factory_runs SET merge_sha = ? WHERE run_id = ? AND merge_sha IS NULL").run(sha, row.run_id).changes;
      if (changes === 0) return false;
      recordEvent(db, row.run_id, "state_change", {
        entity: "merge_sha",
        to: sha,
        previous: null,
        source: "backfill",
        pr_number: row.pr_number,
        owner: opts.owner,
      });
      return true;
    });
    if (wrote) result.filled.push({ run_id: row.run_id, pr_number: row.pr_number, merge_sha: sha });
  }
  return result;
}

/** The error a failed lookup stops the backfill with: gh's own, plus what the sweep did and didn't reach. */
function backfillStopped(
  err: FactoryError,
  done: BackfillResult,
  failed: { run_id: string; pr_number: number },
  waiting: { run_id: string; pr_number: number }[],
): FactoryError {
  const list = waiting.map((w) => `${w.run_id} (PR #${w.pr_number})`).join(", ");
  const message =
    `${err.message}; backfill stopped at ${failed.run_id} (PR #${failed.pr_number}). ` +
    `Filled ${done.filled.length} before it (kept), skipped ${done.skipped.length}; still waiting: ${list}. ` +
    `Run backfill-merge-shas again once gh works: it looks up only the runs still waiting.`;
  return new FactoryError(err.code, message, err.kind, {
    filled: done.filled,
    skipped: done.skipped,
    failed: { run_id: failed.run_id, pr_number: failed.pr_number },
    waiting: waiting.map((w) => ({ run_id: w.run_id, pr_number: w.pr_number })),
  });
}
