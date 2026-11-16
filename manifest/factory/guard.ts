import type { Database } from "better-sqlite3";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { atomicWrite } from "./util.ts";
import { git } from "./context.ts";
import { getRun, type RunState } from "./state.ts";
import { activeAuthorization } from "./runs.ts";
import { readSettings } from "./settings.ts";

/**
 * The `factory exec` guard's marker (§4.1). While a worktree's run is being
 * implemented under an active authorization, the runner keeps a small JSON
 * file inside the worktree's git directory naming the run and the project's
 * `static` and `verify` commands. The PreToolUse hook
 * (hooks/factory-exec-guard.sh) reads only this file, so it costs nothing
 * in worktrees without one: it refuses those commands when they don't go
 * through `factory exec`, which queues them on the shared build lock.
 *
 * The marker exists exactly when all hold:
 * - the run is approved, implementing or validating;
 * - it has an active authorization;
 * - the project's `exec-hook` setting is `on` (the default);
 * - `static` or `verify` is configured.
 *
 * The CLI re-syncs it after every command that names a run, so it follows
 * every state change, revocation and close; `resume` heals a marker a
 * crash left behind, and the hook ignores one past the run deadline.
 */

export const GUARD_FILE = "escapement-factory-run.json";

const GUARDED_STATES: readonly RunState[] = ["approved", "implementing", "validating"];

export type GuardMarker = {
  version: 1;
  run_id: string;
  worktree_path: string;
  deadline_at: string | null;
  commands: string[];
};

/** `$(git rev-parse --git-path escapement-factory-run.json)`: per worktree, inside .git. */
export function guardPath(worktree: string): string {
  const rel = git(["rev-parse", "--git-path", GUARD_FILE], worktree);
  return isAbsolute(rel) ? rel : resolve(worktree, rel);
}

export function syncGuard(db: Database, runId: string): { path: string | null; active: boolean } {
  const run = getRun(db, runId);
  if (!existsSync(run.worktree_path)) return { path: null, active: false };
  let path: string;
  try {
    path = guardPath(run.worktree_path);
  } catch {
    return { path: null, active: false };
  }
  // Another run of the same worktree may own the marker; leave it alone.
  if (existsSync(path)) {
    try {
      const owner = (JSON.parse(readFileSync(path, "utf-8")) as GuardMarker).run_id;
      if (owner !== runId) {
        const other = db.prepare("SELECT state FROM factory_runs WHERE run_id = ?").get(owner) as { state: RunState } | undefined;
        if (other && other.state !== "closed") return { path, active: false };
      }
    } catch {
      // unreadable: rewritten or removed below
    }
  }

  const { settings } = readSettings(run.worktree_path);
  const commands = [settings.static, settings.verify].filter((c): c is string => Boolean(c));
  const active =
    GUARDED_STATES.includes(run.state) && activeAuthorization(db, runId) !== null && settings.execHook === "on" && commands.length > 0;
  if (!active) {
    rmSync(path, { force: true });
    return { path, active: false };
  }
  const marker: GuardMarker = { version: 1, run_id: runId, worktree_path: run.worktree_path, deadline_at: run.deadline_at, commands };
  const text = JSON.stringify(marker, null, 2) + "\n";
  if (!existsSync(path) || readFileSync(path, "utf-8") !== text) atomicWrite(path, text);
  return { path, active: true };
}
