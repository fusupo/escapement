import type { Database } from "better-sqlite3";
import { resolve } from "node:path";
import { FactoryError, blocked } from "./util.ts";
import { tx, getRun, transitionRun, recordEvent, type RunState } from "./state.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { agentToken, ghJson, remoteOf } from "./github.ts";
import type { Owner } from "./owner.ts";

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
 * The artifact dir stays where it is (the database holds its paths). The
 * merge commit and the operator's action beyond these are recorded later
 * (manifest-sync). Bookkeeping: it works past the deadline, under the
 * worktree lock, so it waits for a live operation to finish.
 */

export type ArchiveResult = {
  run_id: string;
  archive_path: string;
  changed: boolean;
  closed: "merged" | "abandoned" | null;
  pr_state: string | null;
  state: RunState;
};

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
    if (close && run.state !== "closed") {
      if (opts.abandon) {
        action = "abandoned";
      } else if (run.pr_number === null) {
        action = "abandoned";
      } else {
        const env = opts.env ?? process.env;
        const remote = remoteOf(run.worktree_path, run.repo);
        const pr = ghJson<{ state: string; mergedAt: string | null }>(
          ["pr", "view", String(run.pr_number), "-R", remote.ghRepo, "--json", "state,mergedAt"],
          { token: agentToken(env), env },
        );
        prState = pr.state;
        if (pr.state === "MERGED" || pr.mergedAt) action = "merged";
        else if (pr.state === "CLOSED") action = "abandoned";
        else throw blocked("pr_open", `PR #${run.pr_number} is still open; merge or close it first, or pass --abandon`);
      }
    }
    const changed = run.archive_path !== archivePath || action !== null;
    const updated = tx(db, () => {
      if (run.archive_path !== archivePath) {
        db.prepare("UPDATE factory_runs SET archive_path = ? WHERE run_id = ?").run(archivePath, runId);
        recordEvent(db, runId, "state_change", { entity: "archive", to: archivePath, previous: run.archive_path, owner: opts.owner });
      }
      return action
        ? transitionRun(db, runId, "closed", { action, owner: opts.owner, reason: prState ? `PR #${run.pr_number} ${prState.toLowerCase()}` : "archived" })
        : getRun(db, runId);
    });
    return { run_id: runId, archive_path: archivePath, changed, closed: action, pr_state: prState, state: updated.state };
  });
}
