import { realpathSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun } from "./factory/runs.ts";
import { getRun, transitionRun } from "./factory/state.ts";
import { openPr } from "./factory/pr.ts";
import { recordManual } from "./factory/manual.ts";
import { continueRun } from "./factory/fixloop.ts";
import { setFaultKill, FAULT_ENV } from "./factory/fault.ts";
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

/** The run's gate events, oldest first (#110). */
function gateEvents(db: Database, runId: string): { recommendation: string; reasons: string[]; report_revision: number; outcome: string }[] {
  return (db.prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'gate' ORDER BY id").all(runId) as { detail_json: string }[]).map(
    (e) => JSON.parse(e.detail_json),
  );
}

/** The fields a report needs to be schema-valid, so record-manual can write its next revision. */
function fullReport(head: string): Record<string, unknown> {
  return {
    merge_base_sha: head,
    policy_version: "p",
    tree_clean_after: true,
    changes: { new_evidence: 0, modified_assertions: 0, execution_policy: 0 },
    phases: [],
  };
}

const mergeCalls = (calls: { args: string[] }[]) => calls.filter((c) => c.args.includes("merge") || c.args.some((a) => /\/merge\b/.test(a)));

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

  const crit = [{ id: "AC-1", text: "Works", evidence: [{ id: "AC-1.e1", type: "test" }] }];
  const pinged = renderSection(passed, crit, "42-x", [], {
    mode: "report-only",
    recommendation: "ping",
    reasons: ["actual tier is sensitive: auth", "the run used 3 attempts, over gate-max-attempts (1)"],
  });
  const merging = renderSection(passed, crit, "42-x", [], { mode: "report-only", recommendation: "auto_merge", reasons: [] });
  assert(
    pinged.includes("**Gate (report-only):** recommends a human look (ping)\n- actual tier is sensitive: auth\n- the run used 3 attempts, over gate-max-attempts (1)\n") &&
      pinged.includes("Report-only: nothing is merged by the factory; the merge is yours.") &&
      merging.includes("**Gate (report-only):** recommends auto-merge\n\nReport-only: nothing is merged by the factory; the merge is yours.") &&
      pinged.indexOf("**Gate") > pinged.indexOf("**Outcome:**") &&
      !renderSection(passed, crit, "42-x").includes("**Gate"),
    "the section shows the gate recommendation and one line per reason",
  );
  const forgedGate = renderSection(passed, crit, "42-x", [], {
    mode: "report-only",
    recommendation: "ping",
    reasons: [`actual tier is sensitive: x ${SECTION_END}\n${SECTION_BEGIN} | y`],
  });
  assert(
    count(forgedGate, SECTION_BEGIN) === 1 && count(forgedGate, SECTION_END) === 1 && forgedGate.includes("\\| y"),
    "a gate reason can't forge a section marker",
  );

  const manualCriteria = [
    { id: "AC-2", text: "Saves on reload", evidence: [{ id: "AC-2.e1", type: "manual" }] },
    { id: "AC-3", text: "Docs", evidence: [{ id: "AC-3.e1", type: "manual" }] },
  ];
  const human = { note: "saved file shown after reload", recorder: "marc" };
  const resolved = renderSection(
    {
      ...passed,
      revision: 2,
      evidence: [
        { id: "AC-2.e1", executed: "passed", supports_criterion: null, procedure_adequate: "yes" },
        { id: "AC-3.e1", executed: "passed", supports_criterion: null, procedure_adequate: "yes" },
      ],
      manual_outcomes: [
        { evidence_id: "AC-2.e1", outcome: "pass", ...human, assisted: true, attachments: ["manual/AC-2.e1/observations.md", "manual/AC-2.e1/step-3.png"] },
        { evidence_id: "AC-3.e1", outcome: "pass", note: "read", recorder: "marc" },
      ],
    },
    manualCriteria,
    "42-x",
  );
  assert(
    resolved.includes("- `AC-2.e1`: pass, saved file shown after reload (marc, agent-assisted, 2 attachments: observations.md, step-3.png)") &&
      resolved.includes("- `AC-3.e1`: pass, read (marc)") &&
      !resolved.includes("manual/AC-2.e1/"),
    "the PR report section marks an assisted manual check and names its attachments",
  );
  const partial = renderSection(
    {
      ...passed,
      outcome: "pending_manual",
      evidence: [
        { id: "AC-2.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" },
        { id: "AC-3.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" },
      ],
      manual_recorded: [{ evidence_id: "AC-2.e1", outcome: "pass", ...human, assisted: true, attachments: ["manual/AC-2.e1/step-3.png"] }],
    },
    manualCriteria,
    "42-x",
  );
  assert(
    partial.includes("- `AC-2.e1`: recorded pass, saved file shown after reload (marc, agent-assisted, 1 attachment: step-3.png); the report resolves once the other checks are recorded") &&
      partial.includes("- `AC-3.e1`: awaiting a human"),
    "the PR report section shows a recorded but unresolved assisted check while the other checks await a human",
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

  // The gate (#110): a first-attempt pass on a standard tier with a small diff.
  {
    const row = getRun(db, a.run.run_id);
    const events = gateEvents(db, a.run.run_id);
    assert(
      r.gate.recommendation === "auto_merge" &&
        row.gate_recommendation === "auto_merge" &&
        row.gate_reasons_json === "[]" &&
        events.length === 1 &&
        events[0].recommendation === "auto_merge" &&
        events[0].reasons.length === 0,
      "a passing standard run records auto_merge on the run and as one gate event",
    );
    assert(
      r.gate.mode === "report-only" && r.gate.recommendation === "auto_merge" && Array.isArray(r.gate.reasons) && r.gate.checks.length === 10 && r.gate.changed === true,
      "the pr result carries the gate (mode, recommendation, reasons, checks)",
    );
    assert(
      pr.body.includes("**Gate (report-only):** recommends auto-merge") && pr.body.includes("nothing is merged by the factory"),
      "factory pr writes the gate into the PR body",
    );
    assert(
      r.gate.recommendation === "auto_merge" && mergeCalls(stub.calls()).length === 0 && stub.state().prs.every((p) => p.state === "OPEN" && !p.mergedAt),
      "a clean standard run recommends auto_merge and factory pr never calls a merge command",
    );
  }

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
  {
    // Revision 2 added one gate event; refreshing it again changes nothing.
    const events = gateEvents(db, a.run.run_id);
    assert(
      r.gate.changed === false && events.length === 2 && events[1].report_revision === 2 && getRun(db, a.run.run_id).gate_recommendation === "auto_merge",
      "a refresh with an unchanged result adds no gate event",
    );
  }

  console.log("\nNo PR while the fix loop is going (#92)\n");
  {
    const l = setup(db, "acme/w#46", "46-l");
    transitionRun(db, l.run.run_id, "implementing");
    transitionRun(db, l.run.run_id, "validating");
    db.prepare(
      `INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at)
         VALUES (?, 1, 'complete', 'fail', 'x', ?, 'p', ?)`,
    ).run(l.run.run_id, l.run.contract_digest, new Date().toISOString());
    transitionRun(db, l.run.run_id, "implementing", { reason: "attempt 1: fail; fix_loop" });
    const before = stub.state().prs.length;
    await rejects(openPr(db, l.run.run_id, { ...o, title: "t" }), /not_validated/, "a run back in implementing after a failed attempt can't open a PR");
    assert(stub.state().prs.length === before && getRun(db, l.run.run_id).state === "implementing", "nothing is created, and the run stays implementing");
  }

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
  {
    const events = gateEvents(db, b.run.run_id);
    const row = getRun(db, b.run.run_id);
    assert(
      r.gate.recommendation === "ping" &&
        row.gate_recommendation === "ping" &&
        JSON.parse(row.gate_reasons_json!).length === 1 &&
        r.gate.reasons[0].includes("pending_manual: awaiting manual checks AC-1.e1") &&
        events.length === 1 &&
        ys[0].body.includes("recommends a human look (ping)"),
      "a pending_manual run records ping with the awaiting manual checks as its reason",
    );
    assert(r.gate.recommendation === "ping" && mergeCalls(stub.calls()).length === 0, "a ping run never calls a merge command either");
  }

  console.log("\nThe gate after manual checks resolve (#110)\n");
  {
    const mm = setup(db, "acme/w#47", "47-m");
    const head = sh("git", ["rev-parse", "HEAD"], mm.root);
    validated(db, mm.run.run_id, "pending_manual", {
      ...fullReport(head),
      evidence: [{ id: "AC-1.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" }],
    });
    const first = await openPr(db, mm.run.run_id, { ...o, title: "feat: m (#47)" });
    await recordManual(db, mm.run.run_id, "AC-1.e1", "pass", { note: "looked at it", recorder: "marc", owner, lockWaitMs: 2000 });
    const again = await openPr(db, mm.run.run_id, o);
    const body = stub.state().prs.find((p) => p.number === again.pr_number)!.body;
    assert(
      first.gate.recommendation === "ping" &&
        again.outcome === "pass" &&
        again.report_revision === 2 &&
        again.gate.recommendation === "auto_merge" &&
        again.gate.reasons.length === 0 &&
        body.includes("recommends auto-merge"),
      "a refresh after the manual checks resolve to pass re-applies the rules and may recommend auto_merge",
    );
    const events = gateEvents(db, mm.run.run_id);
    const row = getRun(db, mm.run.run_id);
    assert(
      events.map((e) => e.recommendation).join() === "ping,auto_merge" &&
        events[0].outcome === "pending_manual" &&
        row.gate_recommendation === "auto_merge" &&
        row.gate_reasons_json === "[]",
      "the earlier ping stays in the gate events and factory_runs holds the latest result",
    );
  }
  {
    const mf = setup(db, "acme/w#49", "49-f");
    const head = sh("git", ["rev-parse", "HEAD"], mf.root);
    validated(db, mf.run.run_id, "pending_manual", {
      ...fullReport(head),
      evidence: [{ id: "AC-1.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" }],
    });
    await openPr(db, mf.run.run_id, { ...o, title: "feat: f (#49)" });
    // A failed check resolves the report as fail and escalates the run, which keeps its PR.
    await recordManual(db, mf.run.run_id, "AC-1.e1", "fail", { note: "it doesn't save", recorder: "marc", owner, lockWaitMs: 2000 });
    assert(getRun(db, mf.run.run_id).state === "escalated", "a failed manual check escalates the run with its PR");
    const refreshed = await openPr(db, mf.run.run_id, o);
    const body = stub.state().prs.find((p) => p.number === refreshed.pr_number)!.body;
    assert(
      refreshed.outcome === "fail" &&
        refreshed.gate.recommendation === "ping" &&
        refreshed.gate.reasons.some((x) => x.includes("outcome is fail")) &&
        getRun(db, mf.run.run_id).gate_recommendation === "ping" &&
        gateEvents(db, mf.run.run_id).length === 2 &&
        body.includes("recommends a human look (ping)") &&
        body.includes("outcome is fail"),
      "a failed manual check refreshes the PR with a ping for the outcome",
    );
  }

  console.log("\nCrash between recording the gate and the PR (#110)\n");
  {
    const g = setup(db, "acme/w#48", "48-g");
    validated(db, g.run.run_id, "pass");
    process.env[FAULT_ENV] = "pr.gate_recorded";
    setFaultKill((point) => {
      throw new Error(`killed at ${point}`);
    });
    try {
      await rejects(openPr(db, g.run.run_id, { ...o, title: "feat: g (#48)" }), /killed at pr\.gate_recorded/, "the runner dies right after recording the gate");
    } finally {
      delete process.env[FAULT_ENV];
      setFaultKill(null);
    }
    const row = getRun(db, g.run.run_id);
    assert(
      row.gate_recommendation === "auto_merge" &&
        gateEvents(db, g.run.run_id).length === 1 &&
        row.pr_number === null &&
        row.state === "validated" &&
        stub.state().prs.filter((p) => p.headRefName === "48-g").length === 0 &&
        sh("git", ["for-each-ref", "refs/heads/48-g"], g.bare) === "",
      "a crash at pr.gate_recorded leaves the gate recorded once, with no PR created and nothing pushed to the PR",
    );
    const rerun = await openPr(db, g.run.run_id, { ...o, title: "feat: g (#48)" });
    const gs = stub.state().prs.filter((p) => p.headRefName === "48-g");
    assert(
      rerun.action === "created" &&
        rerun.gate.changed === false &&
        gs.length === 1 &&
        gs[0].body.includes("**Gate (report-only):** recommends auto-merge") &&
        gateEvents(db, g.run.run_id).length === 1 &&
        getRun(db, g.run.run_id).pr_number === gs[0].number,
      "rerunning factory pr after that crash creates exactly one PR that shows the recommendation, and the gate events are still one",
    );
  }

  console.log("\nConflicts\n");
  db.prepare("UPDATE factory_runs SET pr_number = 999 WHERE run_id = ?").run(b.run.run_id);
  await rejects(openPr(db, b.run.run_id, o), /pr_conflict/, "a recorded number that isn't the branch's open PR: pr_conflict");
  db.prepare("UPDATE factory_runs SET pr_number = ? WHERE run_id = ?").run(ys[0].number, b.run.run_id);
  const st = stub.state();
  st.prs.find((p) => p.number === ys[0].number)!.state = "CLOSED";
  stub.setState({ prs: st.prs });
  await rejects(openPr(db, b.run.run_id, o), /pr_not_open/, "the recorded PR was closed: pr_not_open");

  console.log("\nRe-entry after the PR opened (#97)\n");
  {
    /** After continue: commit a change, then a new complete attempt at the new head, and the run validated again. */
    const revalidated = (runId: string, outcome: string, extra: Record<string, unknown> = {}) => {
      const run = getRun(db, runId);
      writeFileSync(join(run.worktree_path, "fix.txt"), `fixed ${Date.now()}\n`);
      sh("git", ["add", "-A"], run.worktree_path);
      sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fix"], run.worktree_path);
      const head = sh("git", ["rev-parse", "HEAD"], run.worktree_path);
      transitionRun(db, runId, "validating");
      const n = (db.prepare("SELECT COUNT(*) AS n FROM factory_attempts WHERE run_id = ?").get(runId) as { n: number }).n + 1;
      db.prepare(
        `INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, started_at)
         VALUES (?, ?, 'complete', ?, ?, ?, 'p', ?)`,
      ).run(runId, n, outcome, head, run.contract_digest, new Date().toISOString());
      const dir = join(run.artifact_dir, "attempts", String(n));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "report.json"),
        JSON.stringify({
          version: 1, run_id: runId, attempt: n, status: "complete", outcome, validation_scope: "branch", head_sha: head,
          target_ref: run.target_ref, target_sha: head, contract_digest: run.contract_digest,
          tier: { proposed: "standard", actual: "standard", reasons: [] },
          evidence: [{ id: "AC-1.e1", executed: "passed", supports_criterion: "yes" }], findings: [], flags: [], ...extra,
        }),
      );
      transitionRun(db, runId, "validated");
      return head;
    };
    const branchPrs = (branch: string) => stub.state().prs.filter((p) => p.headRefName === branch);

    const re = setup(db, "acme/w#60", "60-re");
    validated(db, re.run.run_id, "pass");
    const opened = await openPr(db, re.run.run_id, { ...o, title: "feat: re (#60)", narrative: "## Summary\nFirst take.\n" });
    continueRun(db, re.run.run_id, { reason: "review: rename the flag", trigger: "review_finding", owner });
    const head2 = revalidated(re.run.run_id, "pass");
    const refreshed = await openPr(db, re.run.run_id, o);
    let body = branchPrs("60-re")[0].body;
    assert(
      refreshed.action === "updated" && refreshed.pr_number === opened.pr_number && branchPrs("60-re").length === 1 &&
        refreshed.state === "pr_open" && getRun(db, re.run.run_id).state === "pr_open" && refreshed.attempt === 2 &&
        refreshed.head_sha === head2 && body.includes(head2.slice(0, 7)) && refreshed.gate.recommendation === "ping",
      "after re-entry, pr updates the same PR with the new attempt's report and the run is pr_open again",
    );
    continueRun(db, re.run.run_id, { reason: "operator: one more pass over the docs", owner });
    revalidated(re.run.run_id, "pass");
    const rewritten = await openPr(db, re.run.run_id, { ...o, narrative: "## Summary\nSecond take, after the review.\n" });
    body = branchPrs("60-re")[0].body;
    assert(
      rewritten.action === "updated" && body.startsWith("## Summary\nSecond take") && !body.includes("First take") && count(body, SECTION_BEGIN) === 1,
      "after re-entry, pr with a new narrative replaces the stale narrative and keeps one report section",
    );

    // Two manual checks: AC-1.e1 recorded pass, then AC-2.e1 fail, which escalates the run with its PR.
    const mr = setup(db, "acme/w#61", "61-mr");
    const h1 = sh("git", ["rev-parse", "HEAD"], mr.root);
    const manualEvidence = [
      { id: "AC-1.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" },
      { id: "AC-2.e1", executed: "pending_manual", supports_criterion: null, procedure_adequate: "yes" },
    ];
    validated(db, mr.run.run_id, "pending_manual", { ...fullReport(h1), evidence: manualEvidence });
    await openPr(db, mr.run.run_id, { ...o, title: "feat: mr (#61)" });
    await recordManual(db, mr.run.run_id, "AC-1.e1", "pass", { note: "saves", recorder: "marc", owner, lockWaitMs: 2000 });
    await recordManual(db, mr.run.run_id, "AC-2.e1", "fail", { note: "button missing", recorder: "marc", owner, lockWaitMs: 2000 });
    continueRun(db, mr.run.run_id, { reason: "put the button back", owner });
    const h2 = revalidated(mr.run.run_id, "pending_manual", { ...fullReport(h1), evidence: manualEvidence });
    await openPr(db, mr.run.run_id, o);
    body = branchPrs("61-mr")[0].body;
    assert(
      h2 !== h1 && body.includes(`\`AC-1.e1\`: awaiting a human again: pass at \`${h1.slice(0, 7)}\` (attempt 1), the head moved`) &&
        body.includes(`\`AC-2.e1\`: awaiting a human again: fail at \`${h1.slice(0, 7)}\` (attempt 1)`),
      "the refreshed section shows which manual checks need doing again",
    );

    // A crash after the PR is patched, before the update is recorded.
    const cu = setup(db, "acme/w#62", "62-cu");
    validated(db, cu.run.run_id, "pass");
    const cuOpened = await openPr(db, cu.run.run_id, { ...o, title: "feat: cu (#62)" });
    continueRun(db, cu.run.run_id, { reason: "review: one more case", trigger: "review_finding", owner });
    const cuHead = revalidated(cu.run.run_id, "pass");
    const updatesBefore = (db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE run_id = ? AND json_extract(detail_json, '$.entity') = 'pr'").get(cu.run.run_id) as { n: number }).n;
    process.env[FAULT_ENV] = "pr.updated";
    setFaultKill((point) => {
      throw new Error(`killed at ${point}`);
    });
    try {
      await rejects(openPr(db, cu.run.run_id, o), /killed at pr\.updated/, "the runner dies right after patching the PR");
    } finally {
      delete process.env[FAULT_ENV];
      setFaultKill(null);
    }
    const patched = branchPrs("62-cu")[0].body.includes(cuHead.slice(0, 7));
    const crashed = getRun(db, cu.run.run_id).state;
    const recovered = await openPr(db, cu.run.run_id, o);
    const updatesAfter = (db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE run_id = ? AND json_extract(detail_json, '$.entity') = 'pr'").get(cu.run.run_id) as { n: number }).n;
    assert(
      patched && crashed === "validated" && recovered.action === "updated" && recovered.pr_number === cuOpened.pr_number &&
        recovered.state === "pr_open" && branchPrs("62-cu").length === 1 && updatesAfter === updatesBefore + 1,
      "a crash after the PR is patched (pr.updated) leaves the run validated, and pr again records updated and pr_open with one PR",
    );
  }

  const c = setup(db, "acme/w#44", "44-z");
  validated(db, c.run.run_id, "pass");
  const s2 = stub.state();
  s2.prs.push({ number: 7, url: "https://github.com/fork/w/pull/7", title: "fork", body: "", headRefName: "44-z", baseRefName: "main", owner: "someone-else", state: "OPEN", mergedAt: null });
  stub.setState({ prs: s2.prs });
  db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), c.run.run_id);
  await rejects(openPr(db, c.run.run_id, { ...o, title: "t" }), /run_deadline/, "past the deadline, no new PR is created");
  assert(getRun(db, c.run.run_id).state === "escalated" && stub.state().prs.filter((p) => p.headRefName === "44-z").length === 1, "the run escalates; a fork's PR with the same branch name is ignored");

  console.log("\nThe host before any gh call (#87)\n");
  {
    const codeOf = async (p: Promise<unknown>): Promise<{ code: string; cause?: unknown }> => {
      try {
        await p;
        return { code: "ok" };
      } catch (err) {
        const e = err as { code?: string; detail?: { cause?: unknown } };
        return { code: e.code ?? "thrown", cause: e.detail?.cause };
      }
    };
    const gates = (runId: string) => gateEvents(db, runId).length;

    const off = setup(db, "acme/w#87", "87-off");
    validated(db, off.run.run_id, "pass");
    sh("git", ["remote", "set-url", "origin", "https://gitlab.com/acme/w.git"], off.root);
    let before = stub.calls().length;
    const offResult = await codeOf(openPr(db, off.run.run_id, { ...o, title: "t" }));
    assert(
      offResult.code === "not_github" &&
        offResult.cause === "origin_host" &&
        stub.calls().length === before &&
        gates(off.run.run_id) === 0 &&
        getRun(db, off.run.run_id).state === "validated",
      "factory pr on an origin off github.com is refused with not_github before any gh call",
    );

    // A failing ssh, so even the old order could never reach a network.
    const savedSsh = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = "false";
    try {
      const rw = setup(db, "acme/w#88", "88-rw");
      validated(db, rw.run.run_id, "pass");
      sh("git", ["remote", "set-url", "origin", "git@github.com:acme/w.git"], rw.root);
      sh("git", ["config", "url.ssh://elsewhere.invalid/.insteadOf", "https://github.com/"], rw.root);
      before = stub.calls().length;
      const rwResult = await codeOf(openPr(db, rw.run.run_id, { ...o, title: "t" }));
      assert(
        rwResult.code === "not_github" &&
          rwResult.cause === "push_url" &&
          stub.calls().length === before &&
          gates(rw.run.run_id) === 0 &&
          getRun(db, rw.run.run_id).state === "validated",
        "factory pr refuses a push URL rewritten off github.com before any gh call",
      );
    } finally {
      if (savedSsh === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = savedSsh;
    }
  }

  db.close();
  cleanup();
  console.log("\nAll factory pr tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
