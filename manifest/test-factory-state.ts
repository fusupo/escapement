import { spawnSync, spawn } from "node:child_process";
import {
  RUN_STATES,
  RUN_TRANSITIONS,
  transitionRun,
  transitionAttempt,
  getRun,
  tx,
} from "./factory/state.ts";
import { currentOwner, isAlive, processStartTime } from "./factory/owner.ts";
import { assert, throws, memDb, seedRun } from "./factory/testkit.ts";

function events(db: import("better-sqlite3").Database, runId: string) {
  return (
    db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change' ORDER BY id").all(
      runId,
    ) as { detail_json: string }[]
  ).map((r) => JSON.parse(r.detail_json));
}

async function run() {
  console.log("Run state machine\n");
  const db = await memDb();

  {
    seedRun(db, "r1");
    const path = ["approved", "implementing", "validating", "validated", "pr_open"] as const;
    for (const s of path) transitionRun(db, "r1", s);
    transitionRun(db, "r1", "closed", { action: "merged" });
    const r = getRun(db, "r1");
    assert(r.state === "closed" && r.ended_at !== null, "the main path reaches closed and sets ended_at");
    assert(r.operator_action === "merged", "closing records the operator action");
    const ev = events(db, "r1");
    assert(ev.length === 6 && ev[0].from === "planned" && ev[5].to === "closed", "each transition logs a state_change event");
    throws(() => transitionRun(db, "r1", "approved"), /illegal_transition/, "closed is terminal");
  }

  {
    seedRun(db, "r2");
    throws(() => transitionRun(db, "r2", "validating"), /illegal_transition/, "states can't be skipped");
    throws(() => transitionRun(db, "r2", "closed"), /bad_close_action/, "closing needs merged, rejected or abandoned");
    throws(
      () => transitionRun(db, "r2", "approved", { from: ["implementing"] }),
      /wrong_state/,
      "an expected source state is enforced",
    );
    transitionRun(db, "r2", "escalated", { reason: "run_deadline" });
    assert(getRun(db, "r2").state_reason === "run_deadline", "the reason is stored on the run");
    throws(() => transitionRun(db, "r2", "approved"), /illegal_transition/, "an escalated run can't go back to approved");
    transitionRun(db, "r2", "closed", { action: "abandoned" });
    assert(getRun(db, "r2").state === "closed", "an escalated run can be closed");
  }

  console.log("\nThe fix loop's edges (#92)\n");
  {
    seedRun(db, "fl1", { state: "validating" });
    transitionRun(db, "fl1", "implementing", { reason: "fix_loop" });
    assert(getRun(db, "fl1").state === "implementing", "a validating run can go back to implementing");
    transitionRun(db, "fl1", "validating");
    transitionRun(db, "fl1", "escalated", { reason: "attempt 2: fail" });
    transitionRun(db, "fl1", "implementing", { reason: "continue: fixed the fixture" });
    const r = getRun(db, "fl1");
    assert(r.state === "implementing" && r.state_reason === "continue: fixed the fixture", "an escalated run can go back to implementing");
    assert(RUN_TRANSITIONS.escalated.join() === "implementing,closed", "and otherwise only be closed");
    seedRun(db, "fl2", { state: "blocked" });
    throws(() => transitionRun(db, "fl2", "implementing"), /illegal_transition/, "a blocked run can only be closed");
    assert(
      RUN_TRANSITIONS.pr_open.includes("implementing") && !RUN_TRANSITIONS.validated.includes("implementing"),
      "pr_open can go back to implementing, but validated still cannot",
    );
  }

  {
    const nonTerminal = RUN_STATES.filter((s) => s !== "closed" && s !== "blocked" && s !== "escalated");
    assert(
      nonTerminal.every((s) => RUN_TRANSITIONS[s].includes("blocked") && RUN_TRANSITIONS[s].includes("escalated")),
      "every active state can move to blocked or escalated",
    );
  }

  {
    seedRun(db, "r3");
    db.prepare(
      `INSERT INTO factory_authorizations (run_id, contract_digest, baseline_json, authorizes_json, status, approved_at)
       VALUES ('r3', 'd', '{}', '[]', 'active', 'now')`,
    ).run();
    transitionRun(db, "r3", "closed", { action: "abandoned" });
    const auth = db.prepare("SELECT status, ended_at FROM factory_authorizations WHERE run_id = 'r3'").get() as {
      status: string;
      ended_at: string | null;
    };
    assert(auth.status === "ended" && auth.ended_at !== null, "closing a run ends its active authorization");
  }

  {
    seedRun(db, "r4");
    try {
      tx(db, () => {
        transitionRun(db, "r4", "approved");
        throw new Error("rollback");
      });
    } catch {}
    assert(getRun(db, "r4").state === "planned", "a transition inside a failed outer transaction rolls back");
  }

  console.log("\nAttempt state machine\n");

  {
    seedRun(db, "a1");
    const insert = (n: number) =>
      db
        .prepare(
          `INSERT INTO factory_attempts (run_id, attempt, status, head_sha, contract_digest, policy_version, started_at)
           VALUES ('a1', ?, 'checks_running', 'h', 'd', 'p', 'now')`,
        )
        .run(n);
    insert(1);
    const owner = currentOwner("validate");
    transitionAttempt(db, "a1", 1, "awaiting_review", { owner: null });
    transitionAttempt(db, "a1", 1, "finalizing", { owner });
    const done = transitionAttempt(db, "a1", 1, "complete", { owner: null, outcome: "pass" });
    assert(done.status === "complete" && done.outcome === "pass" && done.ended_at !== null, "an attempt completes with an outcome");
    assert(done.owner_json === null, "completing clears the owner");
    throws(() => transitionAttempt(db, "a1", 1, "interrupted"), /illegal_transition/, "complete is final");

    insert(2);
    transitionAttempt(db, "a1", 2, "complete", { outcome: "fail" });
    assert(true, "a deterministic failure completes straight from checks_running");
    insert(3);
    throws(() => transitionAttempt(db, "a1", 3, "finalizing"), /illegal_transition/, "review can't be skipped");
    transitionAttempt(db, "a1", 3, "interrupted", { reason: "owner dead" });
    assert(
      events(db, "a1").filter((e) => e.entity === "attempt").length === 5,
      "attempt transitions log state_change events",
    );
  }

  console.log("\nOwner liveness\n");

  {
    const me = currentOwner("test");
    assert(me.pid === process.pid && me.start_time !== null, "the current process has a start time");
    assert(isAlive(me), "the current process is alive");

    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" });
    const deadPid = Number(child.stdout);
    assert(!isAlive({ ...me, pid: deadPid, start_time: "1" }), "an exited process is not alive");

    assert(!isAlive({ ...me, start_time: "0" }), "a reused pid with a different start time is not alive");
    assert(isAlive({ ...me, host: "some-other-host" }), "an owner on another host is assumed alive");

    const sleeper = spawn("sleep", ["5"]);
    const st = processStartTime(sleeper.pid!);
    assert(st !== null && isAlive({ ...me, pid: sleeper.pid!, start_time: st }), "a running child is alive");
    sleeper.kill();
  }

  db.close();
  console.log("\nAll factory state tests passed.");
}

await run();
