import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrations.ts";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { allocateAttempt, verdictPath, attemptDir } from "./factory/attempts.ts";
import { resumeRun, runStateForOutcome } from "./factory/resume.ts";
import { getRun, getAttempt, transitionRun, transitionAttempt } from "./factory/state.ts";
import { tryAcquire, listLocks, worktreeLock } from "./factory/locks.ts";
import { currentOwner, type Owner } from "./factory/owner.ts";
import { assert, throws, tempDir, cleanup, makeRepo, sh, contractFor } from "./factory/testkit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(__dirname, "node_modules/tsx/dist/esm/index.mjs");
const HOUR = 3_600_000;

function deadOwner(): Owner {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
  return { ...currentOwner("validate"), pid: Number(r.stdout), start_time: "1" };
}

async function run() {
  const work = tempDir();
  const dbPath = join(work, "manifest.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);
  const me = currentOwner("test");

  let n = 0;
  /** A fresh repo with an approved run in `validating`, plus its HEAD. */
  function validatingRun() {
    n++;
    const root = realpathSync(makeRepo({ branch: `${n}-x` }));
    const r = startRun(db, { workItem: `#${n}`, ctx: projectContext(root), artifactDir: join(work, "art") });
    approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
    transitionRun(db, r.run_id, "implementing");
    transitionRun(db, r.run_id, "validating");
    const head = sh("git", ["rev-parse", "HEAD"], root);
    const alloc = (owner: Owner = me) =>
      allocateAttempt(db, r.run_id, { owner, headSha: head, contractDigest: "d", policyVersion: "p" });
    return { runId: r.run_id, root, head, art: r.artifact_dir, alloc };
  }

  console.log("Attempt allocation\n");
  {
    const v = validatingRun();
    const a1 = v.alloc();
    assert(a1.attempt === 1 && a1.status === "checks_running", "the first attempt is 1, in checks_running");
    assert(JSON.parse(a1.owner_json!).pid === process.pid, "the attempt records its owner");
    transitionAttempt(db, v.runId, 1, "interrupted");
    assert(v.alloc().attempt === 2, "an interrupted attempt keeps its number; the next is 2");
    throws(
      () => allocateAttempt(db, v.runId, { owner: me, headSha: v.head, contractDigest: "d", policyVersion: "p", maxAttempts: 2 }),
      /attempt_budget/,
      "allocation is blocked once max attempts are used (interrupted ones count)",
    );

    // Many processes allocating at once get distinct numbers.
    const script = join(work, "alloc.mts");
    writeFileSync(
      script,
      `import Database from ${JSON.stringify(resolve(__dirname, "node_modules/better-sqlite3/lib/index.js"))};
import { allocateAttempt } from ${JSON.stringify(resolve(__dirname, "factory/attempts.ts"))};
import { currentOwner } from ${JSON.stringify(resolve(__dirname, "factory/owner.ts"))};
const [dbPath, runId] = process.argv.slice(2);
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");
for (let i = 0; i < 5; i++) {
  allocateAttempt(db, runId, { owner: currentOwner("alloc"), headSha: "h", contractDigest: "d", policyVersion: "p" });
}
`,
    );
    const kids = [1, 2, 3, 4].map(() =>
      spawn(process.execPath, ["--import", tsx, script, dbPath, v.runId], { stdio: ["ignore", "inherit", "inherit"] }),
    );
    const codes = await Promise.all(kids.map((k) => new Promise<number | null>((r) => k.on("exit", (c) => r(c)))));
    const nums = (db.prepare("SELECT attempt FROM factory_attempts WHERE run_id = ? ORDER BY attempt").all(v.runId) as {
      attempt: number;
    }[]).map((r) => r.attempt);
    assert(codes.every((c) => c === 0), "four processes allocate concurrently without errors");
    assert(nums.length === 22 && nums.every((x, i) => x === i + 1), "concurrent allocation yields 1..22 with no gaps or duplicates");
  }

  console.log("\nResume rules (§4.7)\n");
  {
    const v = validatingRun();
    v.alloc(deadOwner());
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions[0].action === "interrupted", "checks_running with a dead owner → interrupted");
    assert(getAttempt(db, v.runId, 1).status === "interrupted", "the attempt is marked interrupted");
    assert(getRun(db, v.runId).state === "validating", "the run stays validating; the next validation is a new attempt");
    assert(v.alloc().attempt === 2, "the interrupted attempt counts toward the budget");
  }
  {
    const v = validatingRun();
    v.alloc(me);
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions[0].action === "running" && getAttempt(db, v.runId, 1).status === "checks_running", "checks_running with a live owner is left alone");
  }
  {
    const v = validatingRun();
    v.alloc();
    transitionAttempt(db, v.runId, 1, "awaiting_review", { owner: null });
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions[0].action === "reissue_review", "awaiting_review without a verdict → reissue review");
    assert(getAttempt(db, v.runId, 1).status === "awaiting_review", "awaiting_review is not interrupted");

    mkdirSync(attemptDir(v.art, 1), { recursive: true });
    writeFileSync(verdictPath(v.art, 1), "{}");
    const r2 = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r2.actions[0].action === "record_review", "awaiting_review with a verdict file → record it");

    writeFileSync(join(v.root, "README.md"), "changed\n");
    const r3 = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    const a = getAttempt(db, v.runId, 1);
    assert(r3.actions[0].action === "identity_error", "a dirty tree fails the identity re-check");
    assert(a.status === "complete" && a.outcome === "error", "the attempt completes as error (revision changed)");
    assert(getRun(db, v.runId).state === "escalated", "the completed error attempt escalates the run");
  }
  {
    const v = validatingRun();
    v.alloc();
    transitionAttempt(db, v.runId, 1, "awaiting_review", { owner: null });
    sh("git", ["commit", "-q", "--allow-empty", "-m", "moved"], v.root);
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions[0].action === "identity_error" && /HEAD is/.test(r.actions[0].detail ?? ""), "a moved HEAD with a clean tree also fails identity");
  }
  {
    const v = validatingRun();
    v.alloc();
    transitionAttempt(db, v.runId, 1, "awaiting_review", { owner: null });
    transitionAttempt(db, v.runId, 1, "finalizing", { owner: deadOwner() });
    mkdirSync(attemptDir(v.art, 1), { recursive: true });
    writeFileSync(verdictPath(v.art, 1), "{}");
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions[0].action === "refinalize", "finalizing with a verdict file → re-run finalization");
    assert(getAttempt(db, v.runId, 1).status === "finalizing", "the attempt stays finalizing for idempotent re-finalization");
  }
  {
    const v = validatingRun();
    v.alloc();
    transitionAttempt(db, v.runId, 1, "complete", { owner: null, outcome: "pass" });
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.actions.at(-1)!.action === "advanced_run", "complete with the run not advanced → apply the transition");
    assert(getRun(db, v.runId).state === "validated", "a passing attempt moves the run to validated");
    const again = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(again.actions.length === 0, "resume is idempotent");
  }
  {
    assert(runStateForOutcome("fail") === "escalated", "a failed attempt escalates the run (no fix loop yet)");
    assert(runStateForOutcome("blocked") === "blocked", "a blocked attempt blocks the run");
  }

  console.log("\nResume past the deadline and with stale locks\n");
  {
    const v = validatingRun();
    v.alloc(deadOwner());
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), v.runId);
    tryAcquire(db, worktreeLock(v.root), deadOwner());
    const r = await resumeRun(db, v.runId, { owner: me, lockWaitMs: 1000 });
    assert(r.deadline_passed && r.actions[0].action === "interrupted", "resume still reconciles past the deadline");
    assert(getRun(db, v.runId).state === "escalated", "past the deadline the run is escalated");
    assert(r.released_locks.includes(worktreeLock(v.root)) && listLocks(db).length === 0, "locks held by dead owners are released");
  }
  {
    const v = validatingRun();
    tryAcquire(db, worktreeLock(v.root), { ...currentOwner("validate"), pid: process.ppid, start_time: null });
    let err = "";
    try {
      await resumeRun(db, v.runId, { owner: me, lockWaitMs: 200 });
    } catch (e) {
      err = String((e as { code?: string }).code);
    }
    assert(err === "lock_timeout", "resume waits for a live operation on the worktree");
  }

  db.close();
  console.log("\nAll factory resume tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
