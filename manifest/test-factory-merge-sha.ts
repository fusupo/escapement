import { realpathSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { archiveRun } from "./factory/archive.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, stubGh, contractFor } from "./factory/testkit.ts";

/**
 * #117: a run's merge SHA. `archive --close` records the merged PR's merge
 * commit on the run and in its operator_action event; an abandoned run
 * records none.
 */

const HOUR = 3_600_000;
const owner = currentOwner("test");
const VALIDATED = "a".repeat(40);
const MERGE = "b".repeat(40);

type ActionEvent = { action: string; merge_sha?: string | null };

async function run() {
  const db = await memDb();
  const stub = stubGh();
  const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
  const o = { owner, lockWaitMs: 2000, env };

  /** A worktree with a local bare origin (acme/w), and an approved run in it. */
  function newRun(branch: string): string {
    const root = realpathSync(makeRepo({ branch }));
    const bare = join(tempDir(), "acme", "w.git");
    mkdirSync(bare, { recursive: true });
    sh("git", ["init", "-q", "--bare", bare], tempDir());
    sh("git", ["remote", "add", "origin", bare], root);
    const r = startRun(db, { workItem: `acme/w#${branch}`, ctx: projectContext(root), artifactDir: tempDir() });
    approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
    return r.run_id;
  }

  /** The run validated at VALIDATED with an open-then-`state` PR; MERGED carries a merge commit unless told otherwise. */
  function withPr(runId: string, state: "OPEN" | "CLOSED" | "MERGED", mergeCommit: { oid: string } | null = state === "MERGED" ? { oid: MERGE } : null) {
    transitionRun(db, runId, "implementing");
    transitionRun(db, runId, "validating");
    db.prepare(
      "INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at) VALUES (?, 1, 'complete', 'pass', ?, 'd', 'p', 'now')",
    ).run(runId, VALIDATED);
    transitionRun(db, runId, "validated");
    transitionRun(db, runId, "pr_open");
    const number = 300 + stub.state().prs.length;
    db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(number, runId);
    const prs = stub.state().prs;
    prs.push({
      number,
      url: `https://github.com/acme/w/pull/${number}`,
      title: "t",
      body: "",
      headRefName: "x",
      baseRefName: "main",
      owner: "acme",
      state,
      mergedAt: state === "MERGED" ? new Date().toISOString() : null,
      headRefOid: VALIDATED,
      reviews: [],
      mergeCommit,
    });
    stub.setState({ prs });
    return number;
  }

  const events = (runId: string): ActionEvent[] =>
    (db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'operator_action' ORDER BY id").all(runId) as { detail_json: string }[]).map(
      (e) => JSON.parse(e.detail_json),
    );
  const mergeShaOf = (runId: string) => getRun(db, runId).merge_sha;
  const where = () => join(tempDir(), "archive");

  console.log("archive --close records the merge SHA (#117)\n");
  {
    const m = newRun("117-merged");
    const number = withPr(m, "MERGED");
    const before = stub.calls().length;
    const r = await archiveRun(db, m, { ...o, path: where(), close: true });
    const calls = stub.calls().slice(before);
    assert(r.closed === "merged" && mergeShaOf(m) === MERGE, "a merged PR's merge commit is recorded as the run's merge_sha when archive --close closes it");
    const ev = events(m);
    assert(ev.length === 1 && ev[0].merge_sha === MERGE && r.merge_sha === MERGE, "the operator_action event carries the same merge_sha, and the archive result reports it");
    const view = calls.filter((c) => c.args[1] === "view");
    const fields = view[0]?.args[view[0].args.indexOf("--json") + 1] ?? "";
    assert(
      calls.length === 1 &&
        view.length === 1 &&
        view[0].args[2] === String(number) &&
        fields.split(",").includes("mergeCommit") &&
        view[0].token === "t0ken",
      "the merge commit is requested from the PR as the agent, in the same single pr view call",
    );

    // A merged PR whose merge commit GitHub doesn't report: closed as merged, no SHA invented.
    const n = newRun("117-no-oid");
    withPr(n, "MERGED", null);
    const rn = await archiveRun(db, n, { ...o, path: where(), close: true });
    assert(rn.closed === "merged" && mergeShaOf(n) === null && rn.merge_sha === null && events(n)[0].merge_sha === null, "a merged PR without a merge commit oid records no merge_sha, never a made-up one");
  }

  {
    // Abandoned three ways: the PR closed unmerged, no PR at all, and --abandon on an open PR.
    const closedPr = newRun("117-closed");
    withPr(closedPr, "CLOSED");
    const a = await archiveRun(db, closedPr, { ...o, path: where(), close: true });
    const noPr = newRun("117-nopr");
    const b = await archiveRun(db, noPr, { ...o, path: where(), close: true });
    const forced = newRun("117-forced");
    withPr(forced, "OPEN", { oid: MERGE });
    const viewsBefore = stub.calls().filter((c) => c.args[1] === "view").length;
    const c = await archiveRun(db, forced, { ...o, path: where(), abandon: true });
    const noView = stub.calls().filter((x) => x.args[1] === "view").length === viewsBefore;
    const none = [closedPr, noPr, forced].every((id) => mergeShaOf(id) === null && events(id).length === 1 && events(id)[0].merge_sha === null);
    assert(
      a.closed === "abandoned" && b.closed === "abandoned" && c.closed === "abandoned" && [a, b, c].every((x) => x.merge_sha === null) && none && noView,
      "a run closed as abandoned (closed PR, no PR, or --abandon) records no merge_sha on the run or in its event",
    );
  }

  db.close();
  cleanup();
  console.log("\nAll merge SHA tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
