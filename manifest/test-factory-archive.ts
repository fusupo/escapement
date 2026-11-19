import { realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { archiveRun } from "./factory/archive.ts";
import { continueRun } from "./factory/fixloop.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, stubGh, contractFor } from "./factory/testkit.ts";

const HOUR = 3_600_000;
const owner = currentOwner("test");

async function rejects(p: Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await p;
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ""} ${String(err)}`;
    assert(pattern.test(text), `${msg} (${String(err).split("\n")[0]})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

function authStatus(db: Database, runId: string): string {
  return (db.prepare("SELECT status FROM factory_authorizations WHERE run_id = ?").all(runId) as { status: string }[]).map((a) => a.status).join();
}

async function run() {
  const db = await memDb();
  const stub = stubGh();
  const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
  const root = realpathSync(makeRepo({ branch: "42-x" }));
  const bare = join(tempDir(), "acme", "w.git");
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "add", "origin", bare], root);
  const ctx = projectContext(root);
  const o = { owner, lockWaitMs: 2000, env };

  function newRun(item: string) {
    const r = startRun(db, { workItem: item, ctx, artifactDir: tempDir() });
    approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
    return r.run_id;
  }
  const VALIDATED = "a".repeat(40);
  /**
   * A run with a validated attempt at VALIDATED and a PR in `state`. The
   * PR's head is the validated one unless `pr` says otherwise.
   */
  function withPr(
    runId: string,
    state: "OPEN" | "CLOSED" | "MERGED",
    pr: { headRefOid?: string; reviews?: { state: string; author: { login: string } }[] } = {},
  ) {
    transitionRun(db, runId, "implementing");
    transitionRun(db, runId, "validating");
    db.prepare(
      "INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at) VALUES (?, 1, 'complete', 'pass', ?, 'd', 'p', 'now')",
    ).run(runId, VALIDATED);
    transitionRun(db, runId, "validated");
    transitionRun(db, runId, "pr_open");
    db.prepare("UPDATE factory_runs SET gate_recommendation = 'auto_merge', gate_reasons_json = '[]' WHERE run_id = ?").run(runId);
    const number = 200 + stub.state().prs.length;
    db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(number, runId);
    const prs = stub.state().prs;
    prs.push({
      number,
      url: `https://github.com/acme/w/pull/${number}`,
      title: "t",
      body: "",
      headRefName: "42-x",
      baseRefName: "main",
      owner: "acme",
      state,
      mergedAt: state === "MERGED" ? new Date().toISOString() : null,
      headRefOid: pr.headRefOid ?? VALIDATED,
      reviews: pr.reviews ?? [],
    });
    stub.setState({ prs });
  }
  type ActionEvent = { action: string; pr_state: string | null; changes_requested_by: string[]; validated_head: string | null; final_head: string | null; gate_recommendation: string | null };
  const actionEvents = (runId: string): ActionEvent[] =>
    (db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'operator_action' ORDER BY id").all(runId) as { detail_json: string }[]).map(
      (e) => JSON.parse(e.detail_json),
    );
  const changesRequested = [{ state: "CHANGES_REQUESTED", author: { login: "marc" } }];

  console.log("archive: recording the path\n");
  const a = newRun("acme/w#42");
  const where = join(tempDir(), "archive", "runs", a);
  let r = await archiveRun(db, a, { ...o, path: where });
  assert(r.changed && r.archive_path === where && r.closed === null && r.state === "approved", "records archive_path; the run stays open");
  assert(getRun(db, a).archive_path === where, "archive_path is on the run");
  r = await archiveRun(db, a, { ...o, path: where });
  assert(!r.changed, "the same path again changes nothing");

  console.log("\narchive --close\n");
  r = await archiveRun(db, a, { ...o, path: where, close: true });
  assert(r.closed === "abandoned" && r.state === "closed" && r.pr_state === null, "no PR: closed as abandoned, without asking GitHub");
  assert(getRun(db, a).operator_action === "abandoned" && authStatus(db, a) === "ended", "the action is recorded and the authorization ends");
  assert(stub.calls().length === 0, "GitHub wasn't asked");
  const noPrEvents = actionEvents(a);
  r = await archiveRun(db, a, { ...o, path: where, close: true });
  assert(!r.changed && r.closed === null && r.state === "closed", "closing a closed run changes nothing");

  const b = newRun("acme/w#42");
  assert(b === "acme-w#42-r2", "the worktree can start a new run once the old one is closed");
  withPr(b, "OPEN");
  await rejects(archiveRun(db, b, { ...o, path: where, close: true }), /pr_open/, "an open PR: refused");
  assert(getRun(db, b).state === "pr_open" && getRun(db, b).archive_path === null, "and nothing is recorded");
  await rejects(
    archiveRun(db, b, { ...o, env: { ...env, ESCAPEMENT_AGENT_GH_TOKEN: "" }, path: where, close: true }),
    /no_agent_token/,
    "reading the PR's state needs the agent token",
  );
  const view = stub.calls().find((c) => c.args[1] === "view");
  assert(view !== undefined && view.token === "t0ken" && view.args.includes("acme/w"), "the PR is read as the agent, in the run's repo");
  const viewsBefore = stub.calls().filter((c) => c.args[1] === "view").length;
  r = await archiveRun(db, b, { ...o, path: where, abandon: true });
  assert(r.closed === "abandoned" && r.state === "closed", "--abandon closes it anyway, as abandoned");
  const abandonedB = { result: r.operator_action, column: getRun(db, b).operator_action, events: actionEvents(b) };
  const noGitHub = stub.calls().filter((c) => c.args[1] === "view").length === viewsBefore;

  console.log("\nWhat the operator did (#110)\n");
  /** Every close's `closed` result, which archive-work routes on: still merged or abandoned. */
  const closes: (string | null)[] = [];
  const c = newRun("acme/w#42");
  withPr(c, "MERGED");
  r = await archiveRun(db, c, { ...o, path: where, close: true });
  closes.push(r.closed);
  assert(r.closed === "merged" && r.pr_state === "MERGED", "a merged PR: closed as merged");
  {
    const ev = actionEvents(c);
    const viewCall = stub.calls().filter((x) => x.args[1] === "view").at(-1)!;
    assert(
      r.operator_action === "merged_as_is" &&
        getRun(db, c).operator_action === "merged_as_is" &&
        ev.length === 1 &&
        ev[0].action === "merged_as_is" &&
        ev[0].validated_head === VALIDATED &&
        ev[0].final_head === VALIDATED &&
        ev[0].gate_recommendation === "auto_merge" &&
        viewCall.args.join(" ").includes("headRefOid,reviews") &&
        viewCall.token === "t0ken",
      "a merged PR with no review and the validated head is recorded as merged_as_is, with an operator_action event",
    );
  }

  {
    const e = newRun("acme/w#42");
    withPr(e, "MERGED", { reviews: changesRequested });
    const res = await archiveRun(db, e, { ...o, path: where, close: true });
    closes.push(res.closed);
    const ev = actionEvents(e);
    assert(
      res.operator_action === "changes_requested" && getRun(db, e).operator_action === "changes_requested" && ev[0].changes_requested_by.join() === "marc",
      "a merged PR after a changes-requested review is recorded as changes_requested",
    );
  }

  {
    const f = newRun("acme/w#42");
    withPr(f, "MERGED", { headRefOid: "b".repeat(40), reviews: [{ state: "APPROVED", author: { login: "marc" } }] });
    const res = await archiveRun(db, f, { ...o, path: where, close: true });
    closes.push(res.closed);
    assert(
      res.operator_action === "changes_requested" && actionEvents(f)[0].final_head === "b".repeat(40) && res.closed === "merged",
      "a merged PR whose head moved past the validated head is recorded as changes_requested",
    );
  }

  {
    const g = newRun("acme/w#42");
    withPr(g, "CLOSED", { reviews: [{ state: "COMMENTED", author: { login: "relica-ai" } }, ...changesRequested] });
    const res = await archiveRun(db, g, { ...o, path: where, close: true });
    closes.push(res.closed);
    assert(
      res.operator_action === "rejected" && res.closed === "abandoned" && getRun(db, g).operator_action === "rejected",
      "a PR closed unmerged after a changes-requested review is recorded as rejected",
    );
  }

  {
    // Re-entry after the PR opened (#97), through continue: a second attempt
    // at the PR's final head, so the head is the validated one.
    const FIXED = "c".repeat(40);
    const reenter = (runId: string) => {
      continueRun(db, runId, { reason: "review: rename the flag", trigger: "review_finding", owner });
      transitionRun(db, runId, "validating");
      db.prepare(
        "INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at) VALUES (?, 2, 'complete', 'pass', ?, 'd', 'p', 'now')",
      ).run(runId, FIXED);
      transitionRun(db, runId, "validated");
      transitionRun(db, runId, "pr_open");
    };
    const m = newRun("acme/w#42");
    withPr(m, "MERGED", { headRefOid: FIXED });
    reenter(m);
    const res = await archiveRun(db, m, { ...o, path: where, close: true });
    const ev = actionEvents(m)[0] as ActionEvent & { reentries?: { trigger: string; gate_recommendation: string | null; attempt: number; head_sha: string }[] };
    assert(
      res.operator_action === "changes_requested" && res.closed === "merged" && ev.validated_head === FIXED && ev.final_head === FIXED &&
        ev.changes_requested_by.length === 0,
      "a merged run that re-entered after its PR opened is recorded as changes_requested even when the head is the validated head",
    );
    assert(
      ev.reentries?.length === 1 && ev.reentries[0].trigger === "review_finding" && ev.reentries[0].gate_recommendation === "auto_merge" &&
        ev.reentries[0].attempt === 1 && ev.reentries[0].head_sha === VALIDATED,
      "the operator_action event lists the re-entries with trigger, gate recommendation, head and attempt",
    );

    const rj = newRun("acme/w#42");
    withPr(rj, "CLOSED", { headRefOid: FIXED, reviews: changesRequested });
    reenter(rj);
    const rjRes = await archiveRun(db, rj, { ...o, path: where, close: true });
    const ab = newRun("acme/w#42");
    withPr(ab, "CLOSED", { headRefOid: FIXED });
    reenter(ab);
    const abRes = await archiveRun(db, ab, { ...o, path: where, close: true });
    assert(
      rjRes.operator_action === "rejected" && abRes.operator_action === "abandoned" && rjRes.closed === "abandoned" && abRes.closed === "abandoned",
      "a re-entered run closed unmerged is rejected after a changes-requested review and abandoned without one",
    );
  }

  const d = newRun("acme/w#42");
  withPr(d, "CLOSED", { reviews: [{ state: "DISMISSED", author: { login: "marc" } }] });
  r = await archiveRun(db, d, { ...o, path: where, close: true });
  closes.push(r.closed);
  assert(r.closed === "abandoned" && r.pr_state === "CLOSED", "a PR closed without merging: abandoned");
  assert(
    r.operator_action === "abandoned" &&
      getRun(db, d).operator_action === "abandoned" &&
      noPrEvents.length === 1 &&
      noPrEvents[0].action === "abandoned" &&
      noPrEvents[0].pr_state === null &&
      abandonedB.result === "abandoned" &&
      abandonedB.column === "abandoned" &&
      abandonedB.events.length === 1 &&
      noGitHub,
    "a PR closed unmerged without a review, no PR, and --abandon are recorded as abandoned",
  );

  {
    const before = actionEvents(c).length;
    const again = await archiveRun(db, c, { ...o, path: where, close: true });
    const transitions = (db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change'").all(c) as { detail_json: string }[])
      .map((e) => JSON.parse(e.detail_json) as { entity?: string; to?: string; action?: string })
      .filter((e) => e.entity === "run" && e.to === "closed");
    assert(
      closes.join() === "merged,merged,merged,abandoned,abandoned" &&
        transitions[0]?.action === "merged" &&
        again.closed === null &&
        again.operator_action === null &&
        actionEvents(c).length === before &&
        getRun(db, c).operator_action === "merged_as_is" &&
        transitions.length === 1,
      "the closed result stays merged or abandoned and closing again adds no operator_action event",
    );
  }

  db.close();
  cleanup();
  console.log("\nAll archive tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
