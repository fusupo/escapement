import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";
import { scanReverts } from "./factory/reverts.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, stubGh, seedRun } from "./factory/testkit.ts";

/**
 * #117: `factory reverts` links a revert of a run's merged work, found on
 * the target branch in local git, to the run, once.
 */

const owner = currentOwner("test");
const here = dirname(fileURLToPath(import.meta.url));
const gone = "/nonexistent/worktree/gone";

/** Commit a file change on the current branch and return the new commit. */
function commit(repo: string, file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  sh("git", ["add", file], repo);
  sh("git", ["commit", "-q", "-m", msg], repo);
  return sh("git", ["rev-parse", "HEAD"], repo);
}

/** A revert commit written the way git revert and GitHub's Revert button word it. */
function revert(repo: string, sha: string): string {
  sh("git", ["commit", "-q", "--allow-empty", "-m", `Revert ${sha.slice(0, 7)}`, "-m", `This reverts commit ${sha}.`], repo);
  return sh("git", ["rev-parse", "HEAD"], repo);
}

/** A checkout of acme/w on develop, its origin a local bare repo named acme/w.git. */
function checkout(): string {
  const root = realpathSync(makeRepo({ branch: "develop" }));
  const bare = join(tempDir(), "acme", "w.git");
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "add", "origin", bare], root);
  return root;
}

const revertEvents = (db: Database, runId: string) =>
  (db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'revert' ORDER BY id").all(runId) as { detail_json: string }[]).map(
    (e) => JSON.parse(e.detail_json) as Record<string, string>,
  );
const closed = (db: Database, runId: string, fields: Record<string, unknown>) =>
  seedRun(db, runId, { repo: "acme/w", worktree_path: gone, state: "closed", target_ref: "develop", ...fields });

async function run() {
  console.log("Reverts of a run's merged work (#117)\n");

  // History on develop: a feature branch (two commits) merged with a merge
  // commit, a squash-merged commit, an unrelated commit, then reverts.
  const w = checkout();
  sh("git", ["checkout", "-q", "-b", "feature"], w);
  const p1 = commit(w, "a.txt", "feature one");
  const p2 = commit(w, "b.txt", "feature two");
  sh("git", ["checkout", "-q", "develop"], w);
  sh("git", ["merge", "-q", "--no-ff", "-m", "Merge pull request #1 from acme/feature", "feature"], w);
  const merge = sh("git", ["rev-parse", "HEAD"], w);
  const squash = commit(w, "c.txt", "squash-merged change (#2)");
  const unrelated = commit(w, "d.txt", "unrelated work");
  const beforeReverts = sh("git", ["rev-parse", "HEAD"], w);
  const rMerge = revert(w, merge);
  const rOwn = revert(w, p1);
  const rSquash = revert(w, squash);
  revert(w, unrelated);

  const db = await memDb();
  closed(db, "acme-w#1-r1", { merge_sha: merge, pr_number: 1, operator_action: "merged_as_is" });
  closed(db, "acme-w#2-r1", { merge_sha: squash, pr_number: 2, operator_action: "merged" });
  closed(db, "acme-w#3-r1", { merge_sha: null, pr_number: 3, operator_action: "merged_as_is" });
  closed(db, "acme-w#4-r1", { merge_sha: null, pr_number: null, operator_action: "abandoned" });
  // Another repository's run whose merge SHA is reverted here: not this repo's.
  seedRun(db, "other-x#1-r1", { repo: "other/x", worktree_path: gone, state: "closed", target_ref: "develop", merge_sha: merge });

  // The scan reads local git only: a gh stub on PATH sees nothing, and no
  // fetch happens (no FETCH_HEAD, remote-tracking refs unchanged).
  const stub = stubGh();
  const savedPath = process.env.PATH;
  const refsBefore = sh("git", ["for-each-ref", "refs/remotes"], w);
  process.env.PATH = stub.path;
  let r;
  try {
    r = scanReverts(db, { worktree: w, owner });
  } finally {
    process.env.PATH = savedPath;
  }
  const gitDir = sh("git", ["rev-parse", "--absolute-git-dir"], w);
  const source = readFileSync(join(here, "factory", "reverts.ts"), "utf-8");
  assert(
    stub.calls().length === 0 &&
      !existsSync(join(gitDir, "FETCH_HEAD")) &&
      sh("git", ["for-each-ref", "refs/remotes"], w) === refsBefore &&
      !/from "\.\/github\.ts"|\bgh\(|ghJson|"fetch"/.test(source),
    "the scan reads local git only: it makes no gh call and never fetches",
  );

  const one = revertEvents(db, "acme-w#1-r1");
  const ofMerge = one.find((e) => e.revert_sha === rMerge);
  assert(
    !!ofMerge &&
      ofMerge.reverted_sha === merge &&
      ofMerge.merge_sha === merge &&
      ofMerge.run_id === "acme-w#1-r1" &&
      ofMerge.target_ref === "develop" &&
      !Number.isNaN(Date.parse(ofMerge.found_at)) &&
      r.recorded.some((x) => x.run_id === "acme-w#1-r1" && x.revert_sha === rMerge),
    "a commit whose message says This reverts commit with the run's merge SHA is recorded as a revert event on that run, with revert_sha, reverted_sha, merge_sha and found_at",
  );
  const ofOwn = one.find((e) => e.revert_sha === rOwn);
  assert(
    !!ofOwn && ofOwn.reverted_sha === p1 && ofOwn.merge_sha === merge && one.length === 2 && p2 !== p1,
    "a revert of one of the PR's own commits (second-parent side of a merge commit) is linked to the run",
  );
  const two = revertEvents(db, "acme-w#2-r1");
  assert(
    two.length === 1 && two[0].revert_sha === rSquash && two[0].reverted_sha === squash,
    "a squash or rebase merge (one parent) is matched by its merge SHA",
  );
  assert(
    revertEvents(db, "acme-w#3-r1").length === 0 &&
      revertEvents(db, "acme-w#4-r1").length === 0 &&
      r.recorded.length === 3 &&
      r.recorded.every((x) => x.reverted_sha !== unrelated),
    "commits that revert something else, and runs with no merge_sha, record no event",
  );
  assert(
    r.repo === "acme/w" && one.length === 2 && revertEvents(db, "other-x#1-r1").length === 0 && r.recorded.every((x) => x.run_id.startsWith("acme-w#")),
    "the scan reads git in the checkout it is run from, so runs whose worktree_path no longer exists are still scanned and runs of another repo are left alone",
  );

  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE kind = 'revert'").get() as { n: number }).n;
  const before = count();
  const again = scanReverts(db, { worktree: w, owner });
  assert(again.recorded.length === 0 && again.already === 3 && count() === before, "scanning again records no second event for the same revert");

  // origin's target branch wins when it exists: there it predates the reverts.
  const db2 = await memDb();
  seedRun(db2, "acme-w#1-r1", { repo: "acme/w", worktree_path: gone, state: "closed", target_ref: "develop", merge_sha: merge });
  sh("git", ["update-ref", "refs/remotes/origin/develop", beforeReverts], w);
  const viaOrigin = scanReverts(db2, { worktree: w, owner });
  sh("git", ["update-ref", "-d", "refs/remotes/origin/develop"], w);
  const viaLocal = scanReverts(db2, { worktree: w, owner });
  const localTip = sh("git", ["rev-parse", "develop"], w);
  // A target branch that isn't there is skipped, not an error.
  const db3 = await memDb();
  seedRun(db3, "acme-w#9-r1", { repo: "acme/w", worktree_path: gone, state: "closed", target_ref: "nowhere", merge_sha: merge });
  const missing = scanReverts(db3, { worktree: w, owner });
  assert(
    viaOrigin.scanned.length === 1 &&
      viaOrigin.scanned[0].ref === "origin/develop" &&
      viaOrigin.scanned[0].tip === beforeReverts &&
      viaOrigin.recorded.length === 0 &&
      viaLocal.scanned[0].ref === "develop" &&
      viaLocal.scanned[0].tip === localTip &&
      viaLocal.recorded.length === 2 &&
      missing.scanned.length === 0 &&
      missing.skipped.length === 1 &&
      missing.skipped[0].target_ref === "nowhere",
    "the scan reads origin's target branch when it exists and the local target branch otherwise, and reports the tip it scanned",
  );

  const res = spawnSync("bash", [join(here, "..", "scripts", "factory.sh"), "--json", "--data-dir", tempDir(), "reverts"], { cwd: w, encoding: "utf-8" });
  const out = JSON.parse(res.stdout || "{}") as { ok?: boolean; result?: { repo?: string; scanned?: unknown[]; recorded?: unknown[]; already?: number } };
  assert(
    res.status === 0 && out.ok === true && out.result?.repo === "acme/w" && out.result.scanned?.length === 0 && out.result.recorded?.length === 0 && out.result.already === 0,
    "with no factory database, reverts answers with an empty result and exit 0, not a usage error",
  );

  db.close();
  db2.close();
  db3.close();
  cleanup();
  console.log("\nAll revert tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
