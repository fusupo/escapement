// Reviewer leftovers (#120): small runner follow-ups from the #87, #97 and
// #117 reviews, each tested here so the existing suites keep their
// assertions as they were.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { backfillMergeShas } from "./factory/archive.ts";
import { allocateAttempt } from "./factory/attempts.ts";
import { projectContext } from "./factory/context.ts";
import { continueRun } from "./factory/fixloop.ts";
import { approveRun, startRun } from "./factory/runs.ts";
import { getRun, transitionAttempt, transitionRun } from "./factory/state.ts";
import { gh } from "./factory/github.ts";
import { renderSection, type ReportView } from "./factory/report-section.ts";
import { currentOwner } from "./factory/owner.ts";
import { FactoryError } from "./factory/util.ts";
import { assert, cleanup, contractFor, makeRepo, memDb, seedRun, sh, stubGh, tempDir } from "./factory/testkit.ts";

const TOKEN = "ghp_test_agent_token_120";
const owner = currentOwner("test");

function stubEnterpriseToken() {
  console.log("The gh stub and GITHUB_ENTERPRISE_TOKEN (item 8)\n");
  const stub = stubGh();
  // Run the stub directly with the variable set: it must log it, or the
  // drop test below would pass whatever gh() does.
  const direct = spawnSync("gh", ["api", "user"], {
    env: { ...process.env, PATH: stub.path, GITHUB_ENTERPRISE_TOKEN: "ent-direct" },
    encoding: "utf-8",
  });
  const seen = stub.calls().at(-1);
  assert(direct.status === 0 && seen?.githubEnterpriseToken === "ent-direct", "the gh stub logs GITHUB_ENTERPRISE_TOKEN when it is set");

  gh(["api", "user"], { token: TOKEN, env: { ...process.env, PATH: stub.path, GITHUB_ENTERPRISE_TOKEN: "ent-token" } });
  const call = stub.calls().at(-1)!;
  assert(call.githubEnterpriseToken === null && call.token === TOKEN, "gh drops GITHUB_ENTERPRISE_TOKEN so the stub never sees it");
}

async function backfillStops() {
  console.log("\nbackfill-merge-shas stopped by a gh failure (item 9)\n");
  const db = await memDb();
  const stub = stubGh();
  const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
  const root = realpathSync(makeRepo({ branch: "main" }));
  const bare = join(tempDir(), "acme", "w.git");
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "add", "origin", bare], root);
  const closed = (runId: string, pr_number: number) =>
    seedRun(db, runId, {
      repo: "acme/w", worktree_path: "/nonexistent/gone", state: "closed", ended_at: new Date().toISOString(), pr_number, operator_action: "merged_as_is",
    });
  const addPr = (number: number, state: "MERGED" | "OPEN", oid: string | null) => {
    const prs = stub.state().prs;
    prs.push({
      number, url: `https://github.com/acme/w/pull/${number}`, title: "t", body: "", headRefName: "x", baseRefName: "main", owner: "acme",
      state, mergedAt: state === "MERGED" ? new Date().toISOString() : null, mergeCommit: oid ? { oid } : null,
    });
    stub.setState({ prs });
  };
  const sha = (runId: string) => (db.prepare("SELECT merge_sha FROM factory_runs WHERE run_id = ?").get(runId) as { merge_sha: string | null }).merge_sha;
  const shaEvents = () =>
    (db.prepare("SELECT detail_json FROM factory_events WHERE kind = 'state_change'").all() as { detail_json: string }[])
      .map((e) => JSON.parse(e.detail_json))
      .filter((d) => d.entity === "merge_sha").length;

  // In lookup order: one skipped (its PR is still open), two filled, then
  // a PR gh can't find, and one more after it.
  closed("acme-w#21-r1", 621);
  closed("acme-w#22-r1", 622);
  closed("acme-w#23-r1", 623);
  closed("acme-w#24-r1", 624);
  closed("acme-w#25-r1", 625);
  addPr(621, "OPEN", null);
  addPr(622, "MERGED", "2".repeat(40));
  addPr(623, "MERGED", "3".repeat(40));
  addPr(625, "MERGED", "5".repeat(40));

  let caught: unknown = null;
  try {
    backfillMergeShas(db, { worktree: root, owner, env });
  } catch (err) {
    caught = err;
  }
  const e = caught instanceof FactoryError ? caught : null;
  const d = (e?.detail ?? {}) as {
    filled?: { run_id: string; merge_sha: string }[];
    skipped?: { run_id: string; reason: string }[];
    failed?: { run_id: string; pr_number: number };
    waiting?: { run_id: string; pr_number: number }[];
  };
  assert(
    e !== null &&
      e.code === "gh_failed" &&
      sha("acme-w#22-r1") === "2".repeat(40) &&
      sha("acme-w#23-r1") === "3".repeat(40) &&
      shaEvents() === 2 &&
      (d.filled ?? []).map((f) => f.run_id).join() === "acme-w#22-r1,acme-w#23-r1" &&
      /Filled 2 before it \(kept\)/.test(e.message),
    "backfill-merge-shas keeps the fills made before a gh failure and lists them as filled in the error",
  );
  assert(
    e !== null &&
      d.failed?.run_id === "acme-w#24-r1" &&
      d.failed?.pr_number === 624 &&
      (d.waiting ?? []).map((w) => `${w.run_id}:${w.pr_number}`).join() === "acme-w#24-r1:624,acme-w#25-r1:625" &&
      (d.skipped ?? []).map((k) => k.run_id).join() === "acme-w#21-r1" &&
      sha("acme-w#25-r1") === null &&
      e.message.includes("stopped at acme-w#24-r1 (PR #624)") &&
      e.message.includes("still waiting: acme-w#24-r1 (PR #624), acme-w#25-r1 (PR #625)") &&
      e.message.includes("skipped 1") &&
      e.message.includes("no pull request 624"),
    "backfill-merge-shas reports the failed run, every run still waiting and the runs it skipped",
  );

  addPr(624, "MERGED", "4".repeat(40));
  const before = stub.calls().length;
  const again = backfillMergeShas(db, { worktree: root, owner, env });
  const looked = stub.calls().slice(before).map((c) => c.args[2]).join();
  assert(
    again.filled.map((f) => f.run_id).join() === "acme-w#24-r1,acme-w#25-r1" &&
      sha("acme-w#24-r1") === "4".repeat(40) &&
      sha("acme-w#25-r1") === "5".repeat(40) &&
      looked === "621,624,625" &&
      shaEvents() === 4,
    "backfill-merge-shas run again after a failure fills the rest and repeats nothing",
  );
}

function redoLine() {
  console.log("\nThe redo line says what happened (item 10)\n");
  const H1 = "1".repeat(40);
  const H2 = "2".repeat(40);
  const report = (head: string, attempt: number, redoHead: string): ReportView => ({
    run_id: "acme-w#7-r1", attempt, outcome: "pending_manual", head_sha: head, target_ref: "main", target_sha: "f".repeat(40),
    contract_digest: "sha256:x", validation_scope: "branch", tier: { proposed: "standard", actual: "standard", reasons: [] },
    evidence: [{ id: "AC-1.e1", executed: "pending_manual", supports_criterion: null }], findings: [], flags: [],
    manual_redo: [{ evidence_id: "AC-1.e1", outcome: "pass", head_sha: redoHead, attempt: 1 }],
  });
  const same = renderSection(report(H1, 2, H1), [], "b");
  assert(
    same.includes("`AC-1.e1`: awaiting a human again: pass at `1111111` (attempt 1), validated again on the same head (attempt 2)") &&
      !same.includes("the head moved"),
    "the redo line says the same head was validated again when it was",
  );
  const moved = renderSection(report(H2, 2, H1), [], "b");
  assert(
    moved.includes("`AC-1.e1`: awaiting a human again: pass at `1111111` (attempt 1), the head moved") && !moved.includes("validated again on the same head"),
    "the redo line still says the head moved when it did",
  );
}

async function runBudgetWithoutPr() {
  console.log("\ncontinue --run-budget on a run without a PR (item 11)\n");
  const HOUR = 3_600_000;
  const db = await memDb();
  const ctxDir = tempDir();
  const root = realpathSync(
    makeRepo({ branch: "120-x", origin: "git@github.com:acme/w.git", claudeMd: `## Escapement Settings\n\n- **context-path**: ${ctxDir}\n` }),
  );
  const ctx = projectContext(root);
  let n = 0;
  /** An approved run with no PR, escalated after a failed attempt (as the fix loop leaves it at a stuck failure). */
  const escalatedNoPr = () => {
    const r = startRun(db, { workItem: `acme/w#${++n}`, ctx: { ...ctx, worktreePath: `/leftovers${n}` }, artifactDir: tempDir() });
    approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR, maxAttempts: 3 });
    transitionRun(db, r.run_id, "implementing");
    transitionRun(db, r.run_id, "validating");
    const a = allocateAttempt(db, r.run_id, { owner, headSha: `head${n}`, contractDigest: getRun(db, r.run_id).contract_digest!, policyVersion: "p" });
    transitionAttempt(db, r.run_id, a.attempt, "complete", { outcome: "fail" });
    transitionRun(db, r.run_id, "escalated", { reason: "stuck" });
    return getRun(db, r.run_id);
  };
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
      return "ok";
    } catch (err) {
      return `${(err as { code?: string }).code}`;
    }
  };

  const r = escalatedNoPr();
  const before = getRun(db, r.run_id);
  const code = codeOf(() => continueRun(db, r.run_id, { reason: "try again", owner, budgetMs: 2 * HOUR }));
  const after = getRun(db, r.run_id);
  assert(
    code === "usage" && after.state === "escalated" && after.deadline_at === before.deadline_at && after.state_reason === before.state_reason,
    "continue with --run-budget on a run without a PR is a usage error and leaves the run as it was",
  );

  const back = escalatedNoPr();
  const first = continueRun(db, back.run_id, { reason: "try again", owner });
  const retry = codeOf(() => continueRun(db, back.run_id, { reason: "try again", owner, budgetMs: 2 * HOUR }));
  const answered = continueRun(db, back.run_id, { reason: "try again", owner, budgetMs: 2 * HOUR });
  assert(
    first.changed && retry === "ok" && !answered.changed && getRun(db, back.run_id).state === "implementing",
    "continue with --run-budget on a run already back in implementing is answered, not refused",
  );
}

async function run() {
  stubEnterpriseToken();
  await backfillStops();
  redoLine();
  await runBudgetWithoutPr();
}

run()
  .then(() => console.log("\nAll reviewer-leftover checks passed."))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(cleanup);
