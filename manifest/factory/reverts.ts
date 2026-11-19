import type { Database } from "better-sqlite3";
import { git, mainRepoRoot, repoName } from "./context.ts";
import { resolveTarget } from "./revision.ts";
import { tx, recordEvent } from "./state.ts";
import { FactoryError, nowIso } from "./util.ts";
import type { Owner } from "./owner.ts";

/**
 * `factory reverts`: link reverts of a run's merged work to the run (#117,
 * §7.2). A run's change that is later undone is one of the outcomes §7.4's
 * false auto-merge rate counts, and the merge SHA (`archive --close`, or
 * `backfill-merge-shas`) is what ties a revert back to the run.
 *
 * - The repository is the checkout the command runs in (cwd or
 *   --project-root), never a run's own `worktree_path`, which is usually gone
 *   by the time a revert lands. Its runs that are closed and have a merge SHA
 *   are looked at, grouped by target branch.
 * - Local git only: the target is `origin/{target_ref}` when that exists, else
 *   the local branch (as validate reads it); nothing is fetched and GitHub is
 *   never asked. The result names the ref and tip each scan read, so a stale
 *   view shows. A target that isn't there is skipped, not an error.
 * - A revert is a commit on the target whose message says
 *   `This reverts commit <sha>` (git revert and GitHub's Revert button both
 *   write it), where the sha is the run's merge SHA or one of its PR's own
 *   commits. For a merge commit (two parents) those are the commits its
 *   second parent brought in (`M^1..M^2`). A squash or rebase merge has one
 *   parent, so only the merge SHA itself matches: a rebase merge's earlier
 *   commits can't be told apart locally. A revert of a revert says the same
 *   words, so it counts as well.
 * - One `revert` event per run and revert commit, recorded once:
 *   `{revert_sha, reverted_sha, run_id, merge_sha, target_ref, found_at}`.
 *   Scanning again records nothing new.
 */

export type RevertRecord = { run_id: string; revert_sha: string; reverted_sha: string; merge_sha: string; target_ref: string };

export type RevertsResult = {
  /** The repository whose runs were looked at, from the checkout the command ran in. */
  repo: string;
  /** Each target branch read: the ref (`origin/{t}` or `{t}`) and its tip then. */
  scanned: { target_ref: string; ref: string; tip: string }[];
  /** Reverts recorded by this call. */
  recorded: RevertRecord[];
  /** Reverts found that an earlier scan had already recorded. */
  already: number;
  /** Target branches that couldn't be read, and why. */
  skipped: { target_ref: string; reason: string }[];
};

const REVERTS = /This reverts commit ([0-9a-f]{40})/g;

/** A git command's output, or null when it fails (an object or ref that isn't there). */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** The commits a run's merge brought: the merge SHA, and for a merge commit the second parent's side. */
function ownCommits(worktree: string, mergeSha: string): Set<string> {
  const own = new Set([mergeSha]);
  const parents = gitOrNull(["rev-list", "--parents", "-n", "1", mergeSha], worktree)?.split(" ").slice(1) ?? [];
  if (parents.length === 2) {
    const side = gitOrNull(["rev-list", `${parents[0]}..${parents[1]}`], worktree);
    for (const sha of side?.split("\n").filter(Boolean) ?? []) own.add(sha);
  }
  return own;
}

/** Commits reachable from `tip` whose message reverts something, with every sha they name. */
function revertCommits(worktree: string, tip: string): { sha: string; reverted: string[] }[] {
  const out = git(["log", "--grep=This reverts commit", "--format=%H%x1f%B%x1e", tip], worktree);
  return out
    .split("\x1e")
    .map((rec) => rec.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [sha, body = ""] = rec.split("\x1f");
      return { sha: sha.trim(), reverted: [...body.matchAll(REVERTS)].map((m) => m[1]) };
    })
    .filter((c) => c.reverted.length > 0);
}

export function scanReverts(db: Database, opts: { worktree: string; owner: Owner; now?: Date }): RevertsResult {
  const repo = repoName(mainRepoRoot(opts.worktree));
  const runs = db
    .prepare(
      "SELECT run_id, merge_sha, target_ref FROM factory_runs WHERE repo = ? AND state = 'closed' AND merge_sha IS NOT NULL ORDER BY started_at, run_id",
    )
    .all(repo) as { run_id: string; merge_sha: string; target_ref: string }[];
  const result: RevertsResult = { repo, scanned: [], recorded: [], already: 0, skipped: [] };
  const byTarget = new Map<string, typeof runs>();
  for (const r of runs) byTarget.set(r.target_ref, [...(byTarget.get(r.target_ref) ?? []), r]);

  const seen = db.prepare("SELECT 1 FROM factory_events WHERE run_id = ? AND kind = 'revert' AND json_extract(detail_json, '$.revert_sha') = ?");
  for (const [targetRef, group] of byTarget) {
    let tip: string;
    try {
      tip = resolveTarget(opts.worktree, targetRef);
    } catch (err) {
      if (!(err instanceof FactoryError)) throw err;
      result.skipped.push({ target_ref: targetRef, reason: err.message });
      continue;
    }
    const ref = gitOrNull(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${targetRef}`], opts.worktree) ? `origin/${targetRef}` : targetRef;
    result.scanned.push({ target_ref: targetRef, ref, tip });
    const reverts = revertCommits(opts.worktree, tip);
    if (reverts.length === 0) continue;
    for (const run of group) {
      const own = ownCommits(opts.worktree, run.merge_sha);
      for (const c of reverts) {
        const reverted = c.reverted.find((s) => own.has(s));
        if (!reverted || c.sha === run.merge_sha) continue;
        const record: RevertRecord = { run_id: run.run_id, revert_sha: c.sha, reverted_sha: reverted, merge_sha: run.merge_sha, target_ref: targetRef };
        const added = tx(db, () => {
          if (seen.get(run.run_id, c.sha)) return false;
          recordEvent(db, run.run_id, "revert", { ...record, found_at: nowIso(opts.now), owner: opts.owner });
          return true;
        });
        if (added) result.recorded.push(record);
        else result.already += 1;
      }
    }
  }
  return result;
}
