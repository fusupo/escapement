import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { validateRun } from "./factory/validate.ts";
import { reviewInput, recordReview, type Bundle } from "./factory/review.ts";
import { recordManual, manualProgress } from "./factory/manual.ts";
import { continueRun } from "./factory/fixloop.ts";
import { openPr } from "./factory/pr.ts";
import { getRun, getAttempt } from "./factory/state.ts";
import { runStatus } from "./factory/runs.ts";
import { schemaErrors } from "./factory/schemas.ts";
import { assert, sh, tempDir, cleanup, stubGh } from "./factory/testkit.ts";
import { owner, TEST_EV, project } from "./factory/fixtures.ts";

const LOCK = { owner, lockWaitMs: 2000 };
const MANUAL_A = { id: "AC-2.e1", type: "manual", kind: "new_behavior", instructions: "Log in on a phone" };
const MANUAL_B = { id: "AC-3.e1", type: "manual", kind: "new_behavior", instructions: "Read docs/auth.md" };
const CRITERIA = [
  { id: "AC-1", text: "Expired tokens are rejected", evidence: [TEST_EV] },
  { id: "AC-2", text: "Login works on mobile", evidence: [MANUAL_A] },
  { id: "AC-3", text: "Docs describe it", evidence: [MANUAL_B] },
];

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8"));

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

/** A run whose attempt 1 completed as pending_manual, with a local origin for PRs. */
async function pendingManual() {
  const p = await project({ contract: { criteria: CRITERIA } });
  const bare = join(tempDir(), "acme", "w.git");
  mkdirSync(dirname(bare), { recursive: true });
  sh("git", ["init", "-q", "--bare", bare], tempDir());
  sh("git", ["remote", "add", "origin", bare], p.root);
  const v = await validateRun(p.db, p.run.run_id, { ...LOCK, echo: false });
  assert(v.status === "awaiting_review", "checks pass; the attempt awaits review");
  const b = readJson<Bundle>((await reviewInput(p.db, p.run.run_id, 1, LOCK)).bundle_path);
  const verdict = {
    version: 1,
    source_digest: b.source.digest,
    evidence: b.required.evidence.map((e) => ({ id: e.id, [e.judgment]: "yes", rationale: "adequate" })),
    sensitive_paths: b.required.sensitive_paths.map((x) => ({ path: x.path, signoff: "approve", rationale: "ok" })),
    modified_assertions: b.required.modified_assertions.map((m) => ({ location: m.location, justified: true, rationale: "ok" })),
    findings: [],
  };
  const rec = await recordReview(p.db, p.run.run_id, 1, JSON.stringify(verdict), LOCK);
  assert(rec.outcome === "pending_manual" && rec.run_state === "validated", "the review leaves two manual checks pending; the run is validated");
  return { ...p, reportPath: rec.report_path };
}

function manualEvents(db: Database, runId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE run_id = ? AND kind = 'manual_outcome'").get(runId) as { n: number }).n;
}

async function run() {
  console.log("record-manual: all pass\n");
  {
    const { db, run, reportPath } = await pendingManual();
    const original = readFileSync(reportPath, "utf-8");
    const id = run.run_id;

    await rejects(recordManual(db, id, "AC-2.e1", "maybe", { ...LOCK, note: "x" }), /usage/, "the outcome is pass or fail");
    await rejects(recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "  " }), /usage[\s\S]*--note/, "a note is required");
    await rejects(recordManual(db, id, "AC-1.e1", "pass", { ...LOCK, note: "x" }), /unknown_evidence[\s\S]*AC-2\.e1, AC-3\.e1/, "test evidence isn't manual: unknown_evidence, naming the pending ones");

    let r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "logged in on Android and iOS", recorder: "marc" });
    assert(!r.noop && r.resolved === null && r.pending.join() === "AC-3.e1" && r.run_state === "validated", "one of two recorded: still pending, run unchanged");
    assert(r.report_path === reportPath && readFileSync(reportPath, "utf-8") === original, "no revision yet; report.json untouched");
    r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "again", recorder: "marc" });
    assert(r.noop && manualEvents(db, id) === 1, "the same outcome again is a no-op");

    r = await recordManual(db, id, "AC-3.e1", "pass", { ...LOCK, note: "docs/auth.md covers expiry", recorder: "marc" });
    assert(r.resolved === "pass" && r.report_revision === 2 && r.report_path.endsWith("report.r2.json"), "the last pass resolves: report.r2.json");
    const r2 = readJson<Record<string, unknown> & { evidence: { id: string; executed: string }[]; manual_outcomes: unknown[] }>(r.report_path);
    assert(r2.outcome === "pass" && r2.revision === 2 && r2.supersedes === "report.json", "revision 2: outcome pass, supersedes report.json");
    assert(r2.evidence.filter((e) => e.id !== "AC-1.e1").every((e) => e.executed === "passed") && r2.manual_outcomes.length === 2, "manual evidence passed, with the human outcomes");
    assert(schemaErrors("report", r2).length === 0, "the revision is a valid report");
    assert(readFileSync(reportPath, "utf-8") === original, "the original report.json is never changed");
    assert(getAttempt(db, id, 1).outcome === "pass" && getRun(db, id).state === "validated", "the attempt's outcome is pass; the run stays validated");
    await rejects(recordManual(db, id, "AC-3.e1", "fail", { ...LOCK, note: "changed my mind" }), /already_resolved/, "once resolved, outcomes can't change");

    // The PR opens from the resolved revision.
    const stub = stubGh();
    const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
    const pr = await openPr(db, id, { ...LOCK, env, title: "feat: x" });
    assert(pr.report_revision === 2 && pr.outcome === "pass" && stub.state().prs[0].body.includes("logged in on Android and iOS"), "factory pr uses the latest revision and shows the human outcomes");
  }

  console.log("\nrecord-manual: a fail escalates, and the PR is refreshed\n");
  {
    const { db, run } = await pendingManual();
    const id = run.run_id;
    const stub = stubGh();
    const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
    const opened = await openPr(db, id, { ...LOCK, env, title: "feat: pending" });
    assert(opened.state === "pr_open" && stub.state().prs[0].body.includes("awaiting a human"), "the PR opens while the manual checks are pending");

    let r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "fine on Android" });
    r = await recordManual(db, id, "AC-2.e1", "fail", { ...LOCK, note: "iOS shows a blank page", recorder: "marc" });
    assert(!r.noop && r.resolved === "fail" && r.report_revision === 2, "a fail resolves the report as fail, even with one check still unrecorded");
    assert(r.run_state === "escalated" && getRun(db, id).state_reason === "manual:AC-2.e1", "and escalates the run, naming the evidence");
    assert(r.refresh_pr && r.pr_number === opened.pr_number, "the result says the open PR needs refreshing");
    const r2 = readJson<{ findings: { id: string; severity: string; detail: string }[] }>(r.report_path);
    assert(r2.findings.some((f) => f.id === "manual:AC-2.e1" && f.severity === "blocking" && f.detail.includes("blank page")), "a blocking finding carries the note");

    const refreshed = await openPr(db, id, { ...LOCK, env });
    const body = stub.state().prs[0].body;
    assert(refreshed.action === "updated" && refreshed.state === "escalated" && body.includes("❌ fail") && body.includes("iOS shows a blank page"), "factory pr refreshes the escalated run's PR to the failed revision");
  }

  console.log("\nrecord-manual: agent-assisted checks (#103)\n");
  {
    const { db, run } = await pendingManual();
    const id = run.run_id;
    const dir = join(run.artifact_dir, "manual", "AC-2.e1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "observations.md"), "Step 3: the editor shows the saved file.\n");
    writeFileSync(join(dir, "step-3.png"), "png");
    const otherDir = join(run.artifact_dir, "manual", "AC-3.e1");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "notes.md"), "x");
    writeFileSync(join(run.artifact_dir, "stray.png"), "x");

    const tries: [Promise<unknown>, RegExp][] = [
      [recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x", attachments: [join(dir, "step-3.png")] }), /^usage .*--assisted/],
      [recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x", assisted: true, attachments: [join(otherDir, "notes.md")] }), /^bad_attachment .*outside/],
      [recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x", assisted: true, attachments: [join(run.artifact_dir, "stray.png")] }), /^bad_attachment .*outside/],
      [recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x", assisted: true, attachments: [join(dir, "missing.png")] }), /^bad_attachment .*doesn't exist/],
    ];
    const refused: boolean[] = [];
    for (const [p, pattern] of tries) refused.push(pattern.test(await p.then(() => "accepted", (err) => `${(err as { code?: string }).code ?? ""} ${String(err)}`)));
    assert(
      refused.every(Boolean) && manualEvents(db, id) === 0,
      "record-manual refuses an attachment outside the evidence's manual dir, a missing file, and --attachment without --assisted",
    );

    const stub = stubGh();
    const env = { ...process.env, PATH: stub.path, ESCAPEMENT_AGENT_GH_TOKEN: "t0ken" };
    const opened = await openPr(db, id, { ...LOCK, env, title: "feat: assisted" });
    const files = [join(dir, "observations.md"), join(dir, "step-3.png")];
    let r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "saved file shown after reload", recorder: "marc", assisted: true, attachments: files });
    const rec = r.recorded.find((m) => m.evidence_id === "AC-2.e1");
    assert(
      !r.noop &&
        r.assisted &&
        r.attachments.join() === "manual/AC-2.e1/observations.md,manual/AC-2.e1/step-3.png" &&
        rec?.recorder === "marc" &&
        rec.assisted &&
        rec.attachments.length === 2,
      "record-manual --assisted stores the assisted mark and the attachments, with the human as recorder",
    );
    const progress = runStatus(db, id).manual;
    assert(
      r.resolved === null &&
        r.refresh_pr &&
        r.pr_number === opened.pr_number &&
        progress?.pending.join() === "AC-3.e1" &&
        progress.recorded.length === 1 &&
        progress.recorded[0].assisted &&
        progress.recorded[0].attachments.length === 2,
      "a recorded but unresolved assisted outcome is listed by record-manual and by factory status, and sets refresh_pr when a PR is open",
    );
    r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "again", assisted: true, attachments: files });
    assert(r.noop && !r.refresh_pr && manualEvents(db, id) === 1, "the same assisted outcome and attachments again is a no-op");
    r = await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "without the screenshot", recorder: "marc", assisted: true, attachments: [files[0]] });
    assert(!r.noop && manualEvents(db, id) === 2 && r.attachments.length === 1, "a different attachment list replaces the record");

    let pr = await openPr(db, id, { ...LOCK, env });
    let body = stub.state().prs[0].body;
    assert(
      pr.action === "updated" && body.includes("agent-assisted") && body.includes("observations.md") && body.includes("awaiting a human"),
      "factory pr refreshes an open PR's report with the assisted mark after record-manual",
    );

    // Past the deadline: recording is bookkeeping and still works.
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), id);
    const docs = join(run.artifact_dir, "manual", "AC-3.e1", "notes.md");
    r = await recordManual(db, id, "AC-3.e1", "pass", { ...LOCK, note: "docs cover expiry", recorder: "marc", assisted: true, attachments: [docs] });
    assert(r.resolved === "pass" && r.report_revision === 2, "an assisted record still works past the run deadline");
    const r2 = readJson<{ manual_outcomes: { evidence_id: string; assisted?: boolean; attachments?: string[]; recorder: string }[] }>(r.report_path);
    assert(
      schemaErrors("report", r2).length === 0 &&
        r2.manual_outcomes.every((m) => m.assisted === true && m.recorder === "marc") &&
        r2.manual_outcomes.find((m) => m.evidence_id === "AC-3.e1")?.attachments?.join() === "manual/AC-3.e1/notes.md",
      "the resolved revision keeps the assisted mark and attachments of every outcome",
    );
    pr = await openPr(db, id, { ...LOCK, env });
    body = stub.state().prs[0].body;
    assert(pr.report_revision === 2 && body.includes("notes.md") && !body.includes("awaiting a human"), "after it resolves, the PR shows the assisted outcomes from the revision");
  }

  console.log("\nrecord-manual: bound to the report's revision\n");
  {
    const { db, root, run } = await pendingManual();
    const id = run.run_id;
    sh("git", ["commit", "-q", "--allow-empty", "-m", "later"], root);
    await rejects(recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x" }), /stale_report/, "after a new commit the report is stale");
    sh("git", ["reset", "-q", "--hard", "HEAD~1"], root);
    db.prepare("UPDATE factory_runs SET contract_digest = 'sha256:other' WHERE run_id = ?").run(id);
    await rejects(recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "x" }), /stale_contract/, "a report for another contract is stale");
    assert(manualEvents(db, id) === 0 && !existsSync(join(run.artifact_dir, "attempts", "1", "report.r2.json")), "refused records leave nothing behind");
  }

  console.log("\nrecord-manual: pending again after a re-entry (#97)\n");
  {
    const { db, root, run } = await pendingManual();
    const id = run.run_id;
    const h1 = getAttempt(db, id, 1).head_sha;
    await recordManual(db, id, "AC-2.e1", "pass", { ...LOCK, note: "logged in", recorder: "marc" });
    db.prepare("UPDATE factory_runs SET pr_number = 5 WHERE run_id = ?").run(id);
    await recordManual(db, id, "AC-3.e1", "fail", { ...LOCK, note: "no Refresh section", recorder: "marc" });
    continueRun(db, id, { reason: "add the Refresh section", owner });
    writeFileSync(join(root, "docs.md"), "## Refresh\n");
    sh("git", ["add", "-A"], root);
    sh("git", ["commit", "-q", "-m", "docs: refresh"], root);
    const v = await validateRun(db, id, { ...LOCK, echo: false });
    const b = readJson<Bundle>((await reviewInput(db, id, v.attempt, LOCK)).bundle_path);
    const verdict = {
      version: 1,
      source_digest: b.source.digest,
      evidence: b.required.evidence.map((e) => ({ id: e.id, [e.judgment]: "yes", rationale: "adequate" })),
      sensitive_paths: b.required.sensitive_paths.map((x) => ({ path: x.path, signoff: "approve", rationale: "ok" })),
      modified_assertions: b.required.modified_assertions.map((m) => ({ location: m.location, justified: true, rationale: "ok" })),
      findings: [],
    };
    const rec = await recordReview(db, id, v.attempt, JSON.stringify(verdict), LOCK);
    const progress = manualProgress(db, getRun(db, id));
    assert(
      rec.outcome === "pending_manual" && v.attempt === 2 && progress !== null && progress.attempt === 2 &&
        progress.pending.join() === "AC-2.e1,AC-3.e1" && progress.recorded.length === 0 &&
        progress.redo.map((r) => `${r.evidence_id}:${r.outcome}:${r.attempt}:${r.head_sha === h1}`).join() === "AC-2.e1:pass:1:true,AC-3.e1:fail:1:true",
      "after re-entry a manual outcome recorded on the old head is pending again and listed as to redo",
    );
  }

  cleanup();
  console.log("\nAll record-manual tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
