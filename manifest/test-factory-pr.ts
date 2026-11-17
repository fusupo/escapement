import { realpathSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { openPr } from "./factory/pr.ts";
import { currentOwner } from "./factory/owner.ts";
import { matchAuthorization } from "./factory/authorization.ts";
import { renderSection, withSection, cell, SECTION_BEGIN, SECTION_END } from "./factory/report-section.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, stubGh, contractFor } from "./factory/testkit.ts";

const HOUR = 3_600_000;
const TOKEN = "ghp_pr_test_token";
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

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** A repo with a local bare origin, a started and approved run, and an artifact dir. */
function setup(db: Database, item: string, branch: string) {
  const root = realpathSync(makeRepo({ branch }));
  const bare = join(tempDir(), "acme", "w.git");
  mkdirSync(bare, { recursive: true });
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "add", "origin", bare], root);
  const ctx = projectContext(root);
  const run = startRun(db, { workItem: item, ctx, artifactDir: tempDir() });
  approveRun(db, run.run_id, { contractFile: contractFor(run.run_id), budgetMs: HOUR });
  return { root, bare, run: getRun(db, run.run_id) };
}

/** Make the run validated with a complete attempt whose report.json says `outcome` at HEAD. */
function validated(db: Database, runId: string, outcome = "pass", extra: Record<string, unknown> = {}): string {
  const run = getRun(db, runId);
  const head = sh("git", ["rev-parse", "HEAD"], run.worktree_path);
  transitionRun(db, runId, "implementing");
  transitionRun(db, runId, "validating");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM factory_attempts WHERE run_id = ?").get(runId) as { n: number }).n + 1;
  db.prepare(
    `INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at)
     VALUES (?, ?, 'complete', ?, ?, ?, 'p', ?)`,
  ).run(runId, n, outcome, head, run.contract_digest, new Date().toISOString());
  const report = {
    version: 1,
    run_id: runId,
    attempt: n,
    status: "complete",
    outcome,
    validation_scope: "branch",
    head_sha: head,
    target_ref: run.target_ref,
    target_sha: head,
    contract_digest: run.contract_digest,
    tier: { proposed: "standard", actual: "standard", reasons: [] },
    evidence: [{ id: "AC-1.e1", executed: "passed", supports_criterion: "yes" }],
    findings: [],
    flags: [],
    ...extra,
  };
  const dir = join(run.artifact_dir, "attempts", String(n));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  if (outcome === "pass" || outcome === "pending_manual") transitionRun(db, runId, "validated");
  return head;
}

async function run() {
  console.log("Report section\n");
  assert(cell("a | b\n c -->x <!-- y") === "a \\| b c --&gt;x &lt;!-- y", "cell text can't break the table or the markers");
  assert(cell("committed as relica-ai <ai@relica.io>") === "committed as relica-ai &lt;ai@relica.io&gt;", "angle brackets are escaped, so GitHub doesn't drop them as a tag");
  assert(withSection("Narrative", "S") === "Narrative\n\nS\n", "the section is appended after the narrative");
  const once = withSection("Top\n\n" + SECTION_BEGIN + "\nold\n" + SECTION_END + "\nBottom", SECTION_BEGIN + "\nnew\n" + SECTION_END);
  assert(once.includes("new") && !once.includes("old") && once.startsWith("Top") && once.endsWith("Bottom"), "an existing section is replaced in place");
  const forged = renderSection(
    {
      run_id: "r", attempt: 1, outcome: "fail", head_sha: "a".repeat(40), target_ref: "main", target_sha: "b".repeat(40),
      contract_digest: "sha256:x", validation_scope: "branch", tier: { proposed: "standard", actual: "sensitive", reasons: ["auth"] },
      evidence: [{ id: "AC-1.e1", executed: "failed", supports_criterion: "no" }],
      findings: [{ id: "review:1", severity: "blocking", detail: `x ${SECTION_END} ${SECTION_BEGIN} y` }],
      flags: ["name_only_match"],
    },
    [{ id: "AC-1", text: "Works", evidence: [{ id: "AC-1.e1", type: "test" }] }],
    "42-x",
  );
  assert(count(forged, SECTION_BEGIN) === 1 && count(forged, SECTION_END) === 1, "reviewer text can't forge a marker");
  assert(forged.includes("❌ fail") && forged.includes("| AC-1 Works | `AC-1.e1` (test) | failed | no |") && forged.includes("sensitive"), "outcome, evidence table and tier are shown");
  assert(!forged.includes("**Attempts**"), "a single attempt has no history table");
  const passed = {
    run_id: "r", attempt: 3, outcome: "pass", head_sha: "a".repeat(40), target_ref: "main", target_sha: "b".repeat(40),
    contract_digest: "sha256:x", validation_scope: "branch", tier: { proposed: "standard", actual: "standard", reasons: [] },
    evidence: [{ id: "AC-1.e1", executed: "passed", supports_criterion: "yes" }], findings: [], flags: [],
  };
  const none = { failed_phase: null, error_cause: null, error_reason: null, blocking: 0 };
  const withHistory = renderSection(passed, [{ id: "AC-1", text: "Works", evidence: [{ id: "AC-1.e1", type: "test" }] }], "42-x", [
    { attempt: 1, status: "complete", outcome: "fail", ...none, blocking: 1 },
    { attempt: 2, status: "complete", outcome: "error", ...none, error_cause: "code", error_reason: "verify timeout <x>" },
    { attempt: 3, status: "complete", outcome: "pass", ...none },
  ]);
  assert(
    withHistory.includes("| 1 | ❌ fail | review: 1 blocking finding |") &&
      withHistory.includes("| 2 | ⚠️ error | code: verify timeout &lt;x&gt; |") &&
      withHistory.includes("| 3 | ✅ pass | - |"),
    "the report section lists every attempt with its outcome",
  );

  console.log("\nPreconditions\n");
  const db = await memDb();
  const stub = stubGh();
  const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: TOKEN };
  const o = { owner, lockWaitMs: 2000, env };
  const a = setup(db, "acme/w#42", "42-x");
  await rejects(openPr(db, a.run.run_id, { ...o, title: "t" }), /not_validated/, "an approved run isn't validated yet");
  transitionRun(db, a.run.run_id, "implementing");
  transitionRun(db, a.run.run_id, "validating");
  db.prepare(
    "INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at) VALUES (?, 1, 'complete', 'fail', 'x', 'd', 'p', ?)",
  ).run(a.run.run_id, new Date().toISOString());
  transitionRun(db, a.run.run_id, "validated");
  await rejects(openPr(db, a.run.run_id, { ...o, title: "t" }), /no_report/, "a complete attempt without its report: no_report");
  db.prepare("DELETE FROM factory_attempts WHERE run_id = ?").run(a.run.run_id);
  db.prepare("UPDATE factory_runs SET state = 'approved' WHERE run_id = ?").run(a.run.run_id);
  validated(db, a.run.run_id, "pass");

  await rejects(openPr(db, a.run.run_id, { ...o, env: { ...env, ESCAPEMENT_AGENT_GH_TOKEN: "" }, title: "t" }), /no_agent_token/, "no agent token: refused");
  writeFileSync(join(a.root, "stray.txt"), "x");
  await rejects(openPr(db, a.run.run_id, { ...o, title: "t" }), /head_moved[\s\S]*not clean/, "a dirty tree: head_moved");
  sh("git", ["add", "stray.txt"], a.root);
  sh("git", ["commit", "-q", "-m", "after validation"], a.root);
  await rejects(openPr(db, a.run.run_id, { ...o, title: "t" }), /head_moved[\s\S]*HEAD is/, "HEAD moved since validation: head_moved");
  sh("git", ["reset", "-q", "--hard", "HEAD~1"], a.root);
  const contractPath = join(a.run.artifact_dir, "contract.json");
  const contract = readFileSync(contractPath, "utf-8");
  writeFileSync(contractPath, contract.replace("It works", "It sort of works"));
  await rejects(openPr(db, a.run.run_id, { ...o, title: "t" }), /contract_mismatch/, "an edited contract.json: contract_mismatch");
  writeFileSync(contractPath, contract);
  await rejects(openPr(db, a.run.run_id, o), /usage[\s\S]*--title/, "creating needs a title");
  assert(stub.state().prs.length === 0 && sh("git", ["for-each-ref", "refs/heads"], a.bare) === "", "nothing was pushed or created by refused calls");

  console.log("\nCreate, then update\n");
  let r = await openPr(db, a.run.run_id, { ...o, title: "feat: thing (#42)", narrative: "## Summary\nDid the thing.\n" });
  assert(r.action === "created" && r.pr_number === 101 && r.state === "pr_open", "creates the PR and moves the run to pr_open");
  assert(getRun(db, a.run.run_id).pr_number === 101, "the PR number is recorded on the run");
  const pr = stub.state().prs[0];
  assert(pr.headRefName === "42-x" && pr.baseRefName === "main" && pr.title === "feat: thing (#42)", "head is the run's branch, base its target");
  assert(pr.body.startsWith("## Summary\nDid the thing.") && count(pr.body, SECTION_BEGIN) === 1 && pr.body.includes("✅ pass"), "body: narrative, then the report section");
  assert(readFileSync(r.body_path, "utf-8") === pr.body && !r.body_path.startsWith(a.root), "the body is kept in the artifact dir, not the worktree");
  assert(sh("git", ["rev-parse", "refs/heads/42-x"], a.bare) === sh("git", ["rev-parse", "HEAD"], a.root), "the branch was pushed");
  const calls = stub.calls();
  assert(calls.every((c) => c.token === TOKEN) && calls.every((c) => !c.args.join(" ").includes(TOKEN)), "every gh call ran as the agent, token never in argv");
  assert(calls.slice(-2).map((c) => c.args[1]).join(",") === "list,create", "looked up first, then created");

  const here = { worktreePath: a.root, repo: getRun(db, a.run.run_id).repo, branch: "42-x" };
  let m = matchAuthorization(db, here);
  assert(m.matched && m.next === "await_merge", "the PR shows the current report: next is await_merge");
  const attemptDir = join(a.run.artifact_dir, "attempts", "1");
  writeFileSync(join(attemptDir, "report.r2.json"), readFileSync(join(attemptDir, "report.json")));
  m = matchAuthorization(db, here);
  assert(m.matched && m.next === "refresh_pr", "a newer report revision: next is refresh_pr");
  r = await openPr(db, a.run.run_id, { ...o, narrative: "## Summary\nRewritten.\n" });
  let now = stub.state().prs;
  assert(r.action === "updated" && r.pr_number === 101 && now.length === 1, "again: the same PR is updated, none created");
  const update = stub.calls().at(-1)!;
  assert(
    update.args.slice(0, 4).join(" ") === "api -X PATCH repos/acme/w/pulls/101" && update.args.includes("-F") && !stub.calls().some((c) => c.args[0] === "pr" && c.args[1] === "edit"),
    "the update goes through the REST API, never gh pr edit (which fails where classic Projects are deprecated)",
  );
  assert(now[0].body.startsWith("## Summary\nRewritten.") && count(now[0].body, SECTION_BEGIN) === 1, "a new narrative replaces the old; one section");
  r = await openPr(db, a.run.run_id, o);
  now = stub.state().prs;
  assert(r.action === "updated" && now[0].body.startsWith("## Summary\nRewritten.") && count(now[0].body, SECTION_END) === 1, "without --body-file the PR's own narrative is kept");
  m = matchAuthorization(db, here);
  assert(r.report_revision === 2 && m.matched && m.next === "await_merge", "refreshed from revision 2: await_merge again");

  console.log("\nAttempt history in the PR (#92)\n");
  {
    const h = setup(db, "acme/w#45", "45-h");
    db.prepare(
      `INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, failed_phase, findings_json, started_at)
         VALUES (?, 1, 'complete', 'fail', 'x', ?, 'p', 'evidence', ?, ?)`,
    ).run(h.run.run_id, h.run.contract_digest, JSON.stringify([{ id: "evidence:AC-1.e1", severity: "blocking", detail: "failed" }]), new Date().toISOString());
    validated(db, h.run.run_id, "pass");
    const res = await openPr(db, h.run.run_id, { ...o, title: "feat: h (#45)" });
    const body = stub.state().prs.find((p) => p.number === res.pr_number)!.body;
    assert(
      res.attempt === 2 && body.includes("**Attempts**") && body.includes("| 1 | ❌ fail | evidence: 1 blocking finding |") && body.includes("| 2 | ✅ pass | - |"),
      "factory pr writes every attempt into the PR body",
    );
  }

  console.log("\nCrash between create and record (AC-3)\n");
  const b = setup(db, "acme/w#43", "43-y");
  validated(db, b.run.run_id, "pending_manual", {
    evidence: [{ id: "AC-1.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" }],
  });
  stub.setState({ crashAfter: "create" });
  await rejects(openPr(db, b.run.run_id, { ...o, title: "feat: y (#43)" }), /gh_failed/, "gh fails after GitHub created the PR");
  assert(getRun(db, b.run.run_id).pr_number === null && getRun(db, b.run.run_id).state === "validated", "nothing recorded: the run is still validated");
  stub.setState({ crashAfter: null });
  r = await openPr(db, b.run.run_id, { ...o, title: "feat: y (#43)" });
  const ys = stub.state().prs.filter((p) => p.headRefName === "43-y");
  assert(r.action === "recovered" && ys.length === 1 && r.pr_number === ys[0].number, "the rerun finds that PR and records it (recovered): no duplicate");
  assert(getRun(db, b.run.run_id).state === "pr_open" && ys[0].body.includes("awaiting a human"), "pending manual checks open the PR and show as awaiting");

  console.log("\nConflicts\n");
  db.prepare("UPDATE factory_runs SET pr_number = 999 WHERE run_id = ?").run(b.run.run_id);
  await rejects(openPr(db, b.run.run_id, o), /pr_conflict/, "a recorded number that isn't the branch's open PR: pr_conflict");
  db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(ys[0].number, b.run.run_id);
  const st = stub.state();
  st.prs.find((p) => p.number === ys[0].number)!.state = "CLOSED";
  stub.setState({ prs: st.prs });
  await rejects(openPr(db, b.run.run_id, o), /pr_not_open/, "the recorded PR was closed: pr_not_open");

  const c = setup(db, "acme/w#44", "44-z");
  validated(db, c.run.run_id, "pass");
  const s2 = stub.state();
  s2.prs.push({ number: 7, url: "https://github.com/fork/w/pull/7", title: "fork", body: "", headRefName: "44-z", baseRefName: "main", owner: "someone-else", state: "OPEN", mergedAt: null });
  stub.setState({ prs: s2.prs });
  db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), c.run.run_id);
  await rejects(openPr(db, c.run.run_id, { ...o, title: "t" }), /run_deadline/, "past the deadline, no new PR is created");
  assert(getRun(db, c.run.run_id).state === "escalated" && stub.state().prs.filter((p) => p.headRefName === "44-z").length === 1, "the run escalates; a fork's PR with the same branch name is ignored");

  db.close();
  cleanup();
  console.log("\nAll factory pr tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
