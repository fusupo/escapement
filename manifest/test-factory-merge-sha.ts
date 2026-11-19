import { spawnSync } from "node:child_process";
import { realpathSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { archiveRun, backfillMergeShas } from "./factory/archive.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, stubGh, contractFor, seedRun } from "./factory/testkit.ts";

/**
 * #117: a run's merge SHA. `archive --close` records the merged PR's merge
 * commit on the run and in its operator_action event; an abandoned run
 * records none. `backfill-merge-shas` fills in runs closed before that,
 * from the checkout it runs in.
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

  console.log("\nbackfill-merge-shas (#117)\n");
  {
    const bdb = await memDb();
    const bstub = stubGh();
    const benv = { ...process.env, PATH: bstub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
    /** A checkout of acme/w (its origin a local bare repo named acme/w.git), with no run of its own. */
    const checkout = (origin?: string) => {
      const root = realpathSync(makeRepo({ branch: "main" }));
      if (origin) {
        sh("git", ["remote", "add", "origin", origin], root);
      } else {
        const bare = join(tempDir(), "acme", "w.git");
        mkdirSync(bare, { recursive: true });
        sh("git", ["init", "-q", "--bare", bare], tempDir());
        sh("git", ["remote", "add", "origin", bare], root);
      }
      return root;
    };
    const gone = "/nonexistent/worktree/gone";
    const closed = (runId: string, fields: Record<string, unknown>) =>
      seedRun(bdb, runId, { repo: "acme/w", worktree_path: gone, state: "closed", ended_at: new Date().toISOString(), ...fields });
    const pr = (number: number, state: "MERGED" | "CLOSED", oid: string | null) => {
      const prs = bstub.state().prs;
      prs.push({
        number, url: `https://github.com/acme/w/pull/${number}`, title: "t", body: "", headRefName: "x", baseRefName: "main", owner: "acme",
        state, mergedAt: state === "MERGED" ? new Date().toISOString() : null, mergeCommit: oid ? { oid } : null,
      });
      bstub.setState({ prs });
    };
    const sha = (runId: string) => (bdb.prepare("SELECT merge_sha FROM factory_runs WHERE run_id = ?").get(runId) as { merge_sha: string | null }).merge_sha;
    const shaEvents = (runId: string) =>
      (bdb.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change'").all(runId) as { detail_json: string }[])
        .map((e) => JSON.parse(e.detail_json))
        .filter((d) => d.entity === "merge_sha");
    const M1 = "1".repeat(40);
    const M2 = "2".repeat(40);

    // Two candidates (old 'merged' and #110's merged_as_is), both with worktrees long gone.
    closed("acme-w#1-r1", { pr_number: 501, operator_action: "merged" });
    closed("acme-w#2-r1", { pr_number: 502, operator_action: "merged_as_is" });
    pr(501, "MERGED", M1);
    pr(502, "MERGED", M2);
    // Not candidates: abandoned, no PR, already filled; and one whose PR didn't merge.
    closed("acme-w#3-r1", { pr_number: 503, operator_action: "abandoned" });
    closed("acme-w#4-r1", { pr_number: null, operator_action: "merged" });
    closed("acme-w#5-r1", { pr_number: 505, operator_action: "merged_as_is", merge_sha: "5".repeat(40) });
    closed("acme-w#6-r1", { pr_number: 506, operator_action: "changes_requested" });
    pr(503, "MERGED", "3".repeat(40));
    pr(505, "MERGED", "9".repeat(40));
    pr(506, "CLOSED", null);
    // Another repository's merged run, with a PR number this repo's PRs also use.
    seedRun(bdb, "other-x#1-r1", { repo: "other/x", worktree_path: gone, state: "closed", pr_number: 501, operator_action: "merged_as_is" });

    const here = checkout();
    const before = bstub.calls().length;
    const r = backfillMergeShas(bdb, { worktree: here, owner, env: benv });
    const calls = bstub.calls().slice(before);
    assert(
      r.repo === "acme/w" &&
        sha("acme-w#1-r1") === M1 &&
        sha("acme-w#2-r1") === M2 &&
        r.filled.map((f) => f.run_id).join() === "acme-w#1-r1,acme-w#2-r1" &&
        calls.every((c) => c.token === "t0ken" && c.args[1] === "view" && c.args.includes("acme/w")) &&
        shaEvents("acme-w#1-r1").length === 1 &&
        shaEvents("acme-w#1-r1")[0].to === M1 &&
        shaEvents("acme-w#1-r1")[0].source === "backfill",
      "backfill-merge-shas fills a closed merged run's merge_sha from its PR, as the agent, and records a merge_sha state_change event",
    );
    const looked = calls.map((c) => c.args[2]).sort().join();
    assert(
      sha("acme-w#3-r1") === null &&
        sha("acme-w#4-r1") === null &&
        sha("acme-w#5-r1") === "5".repeat(40) &&
        sha("acme-w#6-r1") === null &&
        looked === "501,502,506" &&
        r.skipped.length === 1 &&
        r.skipped[0].run_id === "acme-w#6-r1" &&
        /not merged/.test(r.skipped[0].reason),
      "the backfill skips abandoned runs, runs with no PR, runs that already have a merge_sha and PRs that did not merge",
    );
    assert(
      sha("other-x#1-r1") === null && r.filled.every((f) => f.run_id.startsWith("acme-w#")) && !calls.some((c) => c.args.includes("other/x")),
      "the backfill reads origin in the checkout it is run from, so a run whose worktree_path no longer exists is still backfilled and a run of another repo is left alone",
    );

    const eventsBefore = (bdb.prepare("SELECT COUNT(*) AS n FROM factory_events").get() as { n: number }).n;
    const again = backfillMergeShas(bdb, { worktree: here, owner, env: benv });
    const eventsAfter = (bdb.prepare("SELECT COUNT(*) AS n FROM factory_events").get() as { n: number }).n;
    assert(
      again.filled.length === 0 && eventsAfter === eventsBefore && sha("acme-w#1-r1") === M1 && sha("acme-w#2-r1") === M2,
      "running the backfill again changes nothing and makes no further event",
    );

    closed("acme-w#7-r1", { pr_number: 507, operator_action: "merged_as_is" });
    pr(507, "MERGED", "7".repeat(40));
    const offCheckout = checkout("https://gitlab.com/acme/w.git");
    const offBefore = bstub.calls().length;
    let code = "ok";
    try {
      backfillMergeShas(bdb, { worktree: offCheckout, owner, env: benv });
    } catch (err) {
      code = (err as { code?: string }).code ?? "thrown";
    }
    assert(
      code === "not_github" && bstub.calls().length === offBefore && sha("acme-w#7-r1") === null,
      "the backfill checks origin's host before its gh call: a non-github origin is refused as not_github and gh is never run",
    );

    const factorySh = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "factory.sh");
    const res = spawnSync("bash", [factorySh, "--json", "--data-dir", tempDir(), "backfill-merge-shas"], { cwd: here, encoding: "utf-8", env: benv });
    const out = JSON.parse(res.stdout || "{}") as { ok?: boolean; result?: { repo?: string; filled?: unknown[]; skipped?: unknown[] } };
    assert(
      res.status === 0 && out.ok === true && out.result?.repo === "acme/w" && out.result?.filled?.length === 0 && out.result?.skipped?.length === 0,
      "with no factory database, backfill-merge-shas answers with an empty result and exit 0, not a usage error",
    );
    bdb.close();
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
