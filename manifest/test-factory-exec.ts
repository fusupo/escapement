import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrations.ts";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { execCommand, execExitCode } from "./factory/exec.ts";
import { getRun } from "./factory/state.ts";
import { tryAcquire, listLocks, BUILD_LOCK } from "./factory/locks.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, tempDir, cleanup, makeRepo, sh } from "./factory/testkit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(__dirname, "node_modules/tsx/dist/esm/index.mjs");
const HOUR = 3_600_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejects(p: Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    assert(pattern.test(`${(err as { code?: string }).code} ${String(err)}`), `${msg} (${String(err)})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  return new Promise((res) => {
    const tick = () => (cond() || Date.now() > end ? res() : setTimeout(tick, 20));
    tick();
  });
}

async function run() {
  console.log("factory exec\n");
  const work = tempDir();
  const dbPath = join(work, "manifest.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  const owner = currentOwner("exec");
  const contract = join(work, "contract.json");
  writeFileSync(contract, "{}");

  const root = realpathSync(makeRepo({ branch: "1-a" }));
  const runA = startRun(db, { workItem: "#1", ctx: projectContext(root), artifactDir: join(work, "art") });
  const opts = { owner, timeoutMs: 10_000, lockWaitMs: 5_000, graceMs: 300 };

  await rejects(execCommand(db, runA.run_id, ["true"], opts), /not_authorized/, "exec without an authorization is blocked");
  approveRun(db, runA.run_id, { contractFile: contract, budgetMs: HOUR });

  {
    const r = await execCommand(db, runA.run_id, ["sh", "-c", "echo out; echo err >&2; pwd"], opts);
    assert(r.outcome === "pass" && r.exit_code === 0 && execExitCode(r) === 0, "a passing command passes");
    const logText = readFileSync(r.log_path, "utf-8");
    assert(logText.includes("out") && logText.includes("err"), "stdout and stderr go to the log");
    assert(logText.includes(root), "the command runs in the run's worktree");
    assert(r.seq === 1 && existsSync(join(runA.artifact_dir, "exec", "1.json")), "a result record is written per exec");
    assert(getRun(db, runA.run_id).state === "implementing", "the first exec moves approved to implementing");
    assert(listLocks(db).length === 0, "locks are released afterwards");
  }

  {
    const r = await execCommand(db, runA.run_id, ["sh", "-c", "exit 3"], opts);
    assert(r.outcome === "fail" && r.exit_code === 3 && execExitCode(r) === 3, "a failing command reports its exit code");
    assert(r.seq === 2, "exec records are numbered in order");
  }

  {
    const r = await execCommand(db, runA.run_id, ["no-such-command-xyz"], opts);
    assert(r.outcome === "error" && r.reason === "spawn_failed", "a command that can't start is an error");
  }

  {
    const pidFile = join(work, "grandchild.pid");
    const start = Date.now();
    const r = await execCommand(
      db,
      runA.run_id,
      ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      { ...opts, timeoutMs: 500 },
    );
    const grandchild = Number(readFileSync(pidFile, "utf-8"));
    assert(r.outcome === "error" && r.reason === "timeout" && execExitCode(r) === 124, "a timed-out command is an error (exit 124)");
    assert(Date.now() - start < 5000, "the timeout fires promptly");
    await waitFor(() => !alive(grandchild), 2000);
    assert(!alive(grandchild), "the timeout kills the whole process group, grandchildren included");
  }

  {
    const pidFile = join(work, "straggler.pid");
    const r = await execCommand(db, runA.run_id, ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; exit 0`], opts);
    const straggler = Number(readFileSync(pidFile, "utf-8"));
    await waitFor(() => !alive(straggler), 2000);
    assert(r.outcome === "pass" && !alive(straggler), "background processes left by a command are cleaned up");
  }

  {
    tryAcquire(db, BUILD_LOCK, { ...currentOwner("someone else"), pid: process.ppid, start_time: null });
    await rejects(
      execCommand(db, runA.run_id, ["true"], { ...opts, lockWaitMs: 300 }),
      /lock_timeout/,
      "exec is blocked when the build lock stays busy past the lock timeout",
    );
    db.prepare("DELETE FROM factory_locks").run();
    assert(getRun(db, runA.run_id).state === "implementing", "a lock timeout doesn't change the run state");
  }

  {
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() + 600).toISOString(), runA.run_id);
    const r = await execCommand(db, runA.run_id, ["sleep", "5"], opts);
    assert(r.outcome === "error" && r.reason === "run_deadline", "the run deadline caps a command's timeout");
    assert(getRun(db, runA.run_id).state === "escalated", "hitting the deadline escalates the run");
    await rejects(execCommand(db, runA.run_id, ["true"], opts), /run_deadline/, "past the deadline exec is refused");
  }

  console.log("\nexec across worktrees\n");
  {
    const wtB = join(tempDir(), "wt-b");
    sh("git", ["worktree", "add", "-q", "-b", "2-b", wtB], root);
    const wtC = join(tempDir(), "wt-c");
    sh("git", ["worktree", "add", "-q", "-b", "3-c", wtC], root);
    const runs = [wtB, wtC].map((wt, i) => {
      const r = startRun(db, { workItem: `#${i + 2}`, ctx: projectContext(wt), artifactDir: join(work, "art") });
      approveRun(db, r.run_id, { contractFile: contract, budgetMs: HOUR });
      return r.run_id;
    });
    const spans = join(work, "spans.jsonl");
    writeFileSync(spans, "");
    const script = join(work, "exec-one.mts");
    writeFileSync(
      script,
      `import Database from ${JSON.stringify(resolve(__dirname, "node_modules/better-sqlite3/lib/index.js"))};
import { execCommand } from ${JSON.stringify(resolve(__dirname, "factory/exec.ts"))};
import { currentOwner } from ${JSON.stringify(resolve(__dirname, "factory/owner.ts"))};
const [dbPath, runId, spans] = process.argv.slice(2);
const db = new Database(dbPath);
const cmd = "node -e \\"const s=Date.now();setTimeout(()=>require('fs').appendFileSync(process.argv[1], JSON.stringify({s,e:Date.now()})+'\\\\n'),400)\\" " + spans;
const r = await execCommand(db, runId, ["sh", "-c", cmd], { owner: currentOwner("exec"), timeoutMs: 20000, lockWaitMs: 20000 });
process.exit(r.outcome === "pass" ? 0 : 1);
`,
    );
    const kids = [...runs, ...runs].map((id) =>
      spawn(process.execPath, ["--import", tsx, script, dbPath, id, spans], { stdio: ["ignore", "inherit", "inherit"] }),
    );
    const codes = await Promise.all(kids.map((k) => new Promise<number | null>((r) => k.on("exit", (c) => r(c)))));
    assert(codes.every((c) => c === 0), "four concurrent execs on two worktrees all succeed");
    const s = readFileSync(spans, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .sort((a, b) => a.s - b.s);
    const overlap = s.some((x, i) => i > 0 && x.s < s[i - 1].e);
    assert(s.length === 4 && !overlap, "concurrent execs across worktrees run one at a time");
  }

  db.close();
  console.log("\nAll factory exec tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
