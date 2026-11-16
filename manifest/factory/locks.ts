import type { Database } from "better-sqlite3";
import { blocked, nowIso, sleepSync } from "./util.ts";
import { isAlive, parseOwner, type Owner } from "./owner.ts";
import { tx, recordEvent } from "./state.ts";

/**
 * Advisory locks shared by every factory process (§4.1), stored as rows in
 * factory_locks rather than as flock()s, so the holder is on record for
 * `resume` and the scheme works wherever SQLite does.
 *
 * - `build`: one build or test command at a time across all worktrees.
 *   The manifest DB is per user, so in practice this is per user.
 * - `worktree:{path}`: one factory operation at a time on a worktree.
 *
 * Nothing outside the factory honours these locks; they only serialize
 * factory commands. A lock whose holder has died (see isAlive) is taken
 * over by the next caller.
 */
export const BUILD_LOCK = "build";

export function worktreeLock(worktreePath: string): string {
  return `worktree:${worktreePath}`;
}

export type LockHolder = Owner & { run_id: string | null };

export type LockRow = { name: string; holder: LockHolder; acquired_at: string };

function sameProcess(a: Owner, b: Owner): boolean {
  return a.pid === b.pid && a.host === b.host && a.start_time === b.start_time;
}

/**
 * Try once to take `name`. Re-acquiring a lock this process already holds
 * succeeds. Returns the live holder when the lock is taken.
 */
export function tryAcquire(
  db: Database,
  name: string,
  owner: Owner,
  runId: string | null = null,
): { acquired: true; tookOverFrom: LockHolder | null } | { acquired: false; holder: LockHolder } {
  return tx(db, () => {
    const row = db.prepare("SELECT owner_json FROM factory_locks WHERE name = ?").get(name) as
      | { owner_json: string }
      | undefined;
    let tookOverFrom: LockHolder | null = null;
    if (row) {
      const holder = parseOwner(row.owner_json) as LockHolder;
      if (sameProcess(holder, owner)) return { acquired: true, tookOverFrom: null };
      if (isAlive(holder)) return { acquired: false, holder };
      tookOverFrom = holder;
      db.prepare("DELETE FROM factory_locks WHERE name = ?").run(name);
      recordEvent(db, runId, "state_change", { entity: "lock", name, to: "taken_over", from_holder: holder });
    }
    const holder: LockHolder = { ...owner, run_id: runId };
    db.prepare("INSERT INTO factory_locks (name, owner_json, acquired_at) VALUES (?, ?, ?)").run(
      name,
      JSON.stringify(holder),
      nowIso(),
    );
    return { acquired: true, tookOverFrom };
  });
}

function describe(h: LockHolder): string {
  return `pid ${h.pid} (${h.command}${h.run_id ? `, run ${h.run_id}` : ""}) since ${h.since}`;
}

/**
 * Take `name`, polling until `deadline` (epoch ms). Past the deadline the
 * request is blocked with `lock_timeout`.
 */
export function acquire(
  db: Database,
  name: string,
  owner: Owner,
  opts: { deadline: number; runId?: string | null; pollMs?: number },
): void {
  let delay = Math.min(opts.pollMs ?? 100, 1000);
  for (;;) {
    const r = tryAcquire(db, name, owner, opts.runId ?? null);
    if (r.acquired) return;
    const left = opts.deadline - Date.now();
    if (left <= 0) {
      throw blocked("lock_timeout", `timed out waiting for lock ${name}, held by ${describe(r.holder)}`);
    }
    sleepSync(Math.min(delay, left));
    delay = Math.min(delay * 2, 1000);
  }
}

/** Release `name` if this owner holds it. Returns whether a row was removed. */
export function release(db: Database, name: string, owner: Owner): boolean {
  return tx(db, () => {
    const row = db.prepare("SELECT owner_json FROM factory_locks WHERE name = ?").get(name) as
      | { owner_json: string }
      | undefined;
    if (!row || !sameProcess(parseOwner(row.owner_json)!, owner)) return false;
    db.prepare("DELETE FROM factory_locks WHERE name = ?").run(name);
    return true;
  });
}

/**
 * Hold `names` while `fn` runs, releasing them afterwards even if it throws.
 * Locks are always taken in the order given (callers pass the worktree lock
 * before the build lock), so two holders can't deadlock. One deadline
 * covers waiting for all of them.
 */
export async function withLocks<T>(
  db: Database,
  names: string[],
  owner: Owner,
  opts: { waitMs: number; runId?: string | null },
  fn: () => Promise<T> | T,
): Promise<T> {
  const deadline = Date.now() + opts.waitMs;
  const held: string[] = [];
  try {
    for (const name of names) {
      acquire(db, name, owner, { deadline, runId: opts.runId });
      held.push(name);
    }
    return await fn();
  } finally {
    for (const name of held.reverse()) release(db, name, owner);
  }
}

export function listLocks(db: Database): (LockRow & { alive: boolean })[] {
  return (
    db.prepare("SELECT name, owner_json, acquired_at FROM factory_locks ORDER BY name").all() as {
      name: string;
      owner_json: string;
      acquired_at: string;
    }[]
  ).map((r) => {
    const holder = parseOwner(r.owner_json) as LockHolder;
    return { name: r.name, holder, acquired_at: r.acquired_at, alive: isAlive(holder) };
  });
}
