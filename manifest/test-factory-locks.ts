import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrations.ts";
import { acquire, release, tryAcquire, withLocks, listLocks, BUILD_LOCK, worktreeLock } from "./factory/locks.ts";
import { currentOwner, type Owner } from "./factory/owner.ts";
import { assert, throws, tempDir, cleanup, seedRun } from "./factory/testkit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(__dirname, "node_modules/tsx/dist/esm/index.mjs");

function fileDb(dir: string) {
  const db = new Database(join(dir, "manifest.db"));
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** A child process that holds `lock` for `holdMs`, logging when it held it. */
function holder(dir: string, lock: string, holdMs: number, log: string) {
  const script = join(dir, "hold.mts");
  writeFileSync(
    script,
    `import Database from ${JSON.stringify(resolve(__dirname, "node_modules/better-sqlite3/lib/index.js"))};
import { appendFileSync } from "node:fs";
import { withLocks } from ${JSON.stringify(resolve(__dirname, "factory/locks.ts"))};
import { currentOwner } from ${JSON.stringify(resolve(__dirname, "factory/owner.ts"))};
import { sleepSync } from ${JSON.stringify(resolve(__dirname, "factory/util.ts"))};
const [dbPath, lock, holdMs, log] = process.argv.slice(2);
const db = new Database(dbPath);
await withLocks(db, [lock], currentOwner("hold"), { waitMs: 10000 }, () => {
  const start = Date.now();
  sleepSync(Number(holdMs));
  appendFileSync(log, JSON.stringify({ pid: process.pid, start, end: Date.now() }) + "\\n");
});
`,
  );
  return spawn(process.execPath, ["--import", tsx, script, join(dir, "manifest.db"), lock, String(holdMs), log], {
    cwd: __dirname,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function exited(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((res) => child.on("exit", (code) => res(code)));
}

async function run() {
  console.log("Factory locks\n");
  const dir = tempDir();
  const db = fileDb(dir);
  const me = currentOwner("test");
  const other: Owner = { ...currentOwner("other"), pid: process.ppid, start_time: null };

  {
    const r = tryAcquire(db, BUILD_LOCK, me, "run-1");
    assert(r.acquired, "a free lock is acquired");
    assert(tryAcquire(db, BUILD_LOCK, me).acquired, "re-acquiring a lock this process holds succeeds");
    const r2 = tryAcquire(db, BUILD_LOCK, other);
    assert(!r2.acquired && r2.holder.pid === process.pid && r2.holder.run_id === "run-1", "a held lock reports its holder and run");
    assert(!release(db, BUILD_LOCK, other), "another owner can't release it");
    const locks = listLocks(db);
    assert(locks.length === 1 && locks[0].alive, "listLocks shows the live holder");
    assert(release(db, BUILD_LOCK, me), "the holder releases it");
    assert(listLocks(db).length === 0, "released locks are gone");
  }

  {
    tryAcquire(db, BUILD_LOCK, other);
    const start = Date.now();
    throws(
      () => acquire(db, BUILD_LOCK, me, { deadline: Date.now() + 300 }),
      /lock_timeout/,
      "waiting past the deadline is blocked with lock_timeout",
    );
    assert(Date.now() - start >= 280, "acquire waited until the deadline");
    db.prepare("DELETE FROM factory_locks").run();
  }

  {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const deadOwner: Owner = { ...me, pid: Number(dead.stdout), start_time: "1", command: "crashed" };
    tryAcquire(db, worktreeLock("/wt"), deadOwner);
    seedRun(db, "run-2");
    const r = tryAcquire(db, worktreeLock("/wt"), me, "run-2");
    assert(r.acquired && r.tookOverFrom?.command === "crashed", "a dead holder's lock is taken over");
    const ev = db.prepare("SELECT detail_json FROM factory_events WHERE run_id = 'run-2'").get() as { detail_json: string };
    assert(JSON.parse(ev.detail_json).to === "taken_over", "a takeover is recorded as an event");

    tryAcquire(db, "reused", { ...me, start_time: "not-my-start-time" });
    assert(tryAcquire(db, "reused", other).acquired, "a reused pid (different start time) counts as dead");
    db.prepare("DELETE FROM factory_locks").run();
  }

  {
    let inside = false;
    await withLocks(db, [worktreeLock("/wt"), BUILD_LOCK], me, { waitMs: 1000 }, () => {
      inside = listLocks(db).length === 2;
    });
    assert(inside && listLocks(db).length === 0, "withLocks holds every lock while fn runs, then releases");
    try {
      await withLocks(db, [BUILD_LOCK], me, { waitMs: 1000 }, () => {
        throw new Error("boom");
      });
    } catch {}
    assert(listLocks(db).length === 0, "withLocks releases on error");
  }

  {
    const log = join(dir, "log.jsonl");
    writeFileSync(log, "");
    const kids = [holder(dir, BUILD_LOCK, 400, log), holder(dir, BUILD_LOCK, 400, log), holder(dir, BUILD_LOCK, 400, log)];
    const codes = await Promise.all(kids.map(exited));
    assert(codes.every((c) => c === 0), "three competing processes all finish");
    const spans = readFileSync(log, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .sort((a, b) => a.start - b.start);
    const overlap = spans.some((s, i) => i > 0 && s.start < spans[i - 1].end);
    assert(spans.length === 3 && !overlap, "processes competing for the build lock never overlap");
  }

  db.close();
  console.log("\nAll factory lock tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
