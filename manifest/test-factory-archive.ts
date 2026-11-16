import { realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { archiveRun } from "./factory/archive.ts";
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
  function withPr(runId: string, state: "OPEN" | "CLOSED" | "MERGED") {
    transitionRun(db, runId, "implementing");
    transitionRun(db, runId, "validating");
    transitionRun(db, runId, "validated");
    transitionRun(db, runId, "pr_open");
    const number = 200 + stub.state().prs.length;
    db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(number, runId);
    const prs = stub.state().prs;
    prs.push({ number, url: `https://github.com/acme/w/pull/${number}`, title: "t", body: "", headRefName: "42-x", baseRefName: "main", owner: "acme", state, mergedAt: state === "MERGED" ? new Date().toISOString() : null });
    stub.setState({ prs });
  }

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
  r = await archiveRun(db, b, { ...o, path: where, abandon: true });
  assert(r.closed === "abandoned" && r.state === "closed", "--abandon closes it anyway, as abandoned");

  const c = newRun("acme/w#42");
  withPr(c, "MERGED");
  r = await archiveRun(db, c, { ...o, path: where, close: true });
  assert(r.closed === "merged" && r.pr_state === "MERGED" && getRun(db, c).operator_action === "merged", "a merged PR: closed as merged");

  const d = newRun("acme/w#42");
  withPr(d, "CLOSED");
  r = await archiveRun(db, d, { ...o, path: where, close: true });
  assert(r.closed === "abandoned" && r.pr_state === "CLOSED", "a PR closed without merging: abandoned");

  db.close();
  cleanup();
  console.log("\nAll archive tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
