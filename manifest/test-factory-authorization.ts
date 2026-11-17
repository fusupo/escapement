import { realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun, revokeRun } from "./factory/runs.ts";
import { transitionRun, getRun } from "./factory/state.ts";
import { matchAuthorization, nextStep } from "./factory/authorization.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, contractFor } from "./factory/testkit.ts";

const HOUR = 3_600_000;

async function run() {
  console.log("authorization: matching a worktree to its run\n");
  const db = await memDb();
  const ctxDir = tempDir();
  const root = realpathSync(
    makeRepo({ branch: "42-x", origin: "git@github.com:acme/w.git", claudeMd: `## Escapement Settings\n\n- **context-path**: ${ctxDir}\n` }),
  );
  const ctx = projectContext(root);
  const here = { worktreePath: root, repo: "acme/w", branch: "42-x" };

  let m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "no_run" && m.run_id === null, "no run in the worktree: no_run");

  // Another worktree's run is never this worktree's.
  startRun(db, { workItem: "acme/w#7", ctx: { ...ctx, worktreePath: "/elsewhere" }, artifactDir: tempDir() });
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "no_run", "a run bound to another worktree doesn't count");

  const r = startRun(db, { workItem: "acme/w#42", ctx });
  m = matchAuthorization(db, here);
  assert(
    !m.matched && m.run_id === r.run_id && m.reasons.includes("run_halted") && m.reasons.includes("no_active_authorization"),
    "a planned run without approval doesn't match",
  );

  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
  m = matchAuthorization(db, here);
  assert(m.matched, "an approved run with its contract matches");
  if (m.matched) {
    assert(m.run_id === "acme-w#42-r1" && m.state === "approved" && m.next === "implement", "it names the run, its state and next step");
    assert(m.authorizes.includes("commit") && m.authorizes.includes("open_pr"), "it lists what the authorization allows");
    assert(m.contract_path === join(r.artifact_dir, "contract.json") && m.pr_number === null && m.latest_attempt === null, "contract path, no PR, no attempt yet");
  }

  m = matchAuthorization(db, { ...here, branch: "other" });
  assert(!m.matched && m.reasons.join() === "branch_mismatch", "another branch checked out: branch_mismatch");
  m = matchAuthorization(db, { ...here, repo: "acme/fork" });
  assert(!m.matched && m.reasons.join() === "repo_mismatch", "another repository: repo_mismatch");

  const contractPath = join(r.artifact_dir, "contract.json");
  writeFileSync(contractPath, '{"tampered": true}\n');
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "contract_changed", "an edited contract.json: contract_changed");
  rmSync(contractPath);
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "contract_missing", "a missing contract.json: contract_missing");
  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
  assert(matchAuthorization(db, here).matched, "re-approving restores contract.json and the match");

  const later = Date.now() + 2 * HOUR;
  m = matchAuthorization(db, here, later);
  assert(!m.matched && m.reasons.join() === "run_deadline", "past the deadline: run_deadline");
  assert(getRun(db, r.run_id).state === "approved", "matching past the deadline doesn't escalate the run (read-only)");

  revokeRun(db, r.run_id);
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "no_active_authorization", "a revoked authorization: no_active_authorization");
  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });

  console.log("\nnext step\n");
  transitionRun(db, r.run_id, "implementing");
  transitionRun(db, r.run_id, "validating");
  db.prepare(
    `INSERT INTO factory_attempts (run_id, attempt, status, head_sha, contract_digest, policy_version, started_at)
     VALUES (?, 1, 'awaiting_review', 'abc', 'd', 'p', ?)`,
  ).run(r.run_id, new Date().toISOString());
  m = matchAuthorization(db, here);
  assert(m.matched && m.next === "review" && m.latest_attempt?.attempt === 1, "an attempt awaiting review: next is review");
  db.prepare("UPDATE factory_attempts SET status = 'checks_running'").run();
  m = matchAuthorization(db, here);
  assert(m.matched && m.next === "resume", "checks still running (or crashed): next is resume");
  db.prepare("UPDATE factory_attempts SET status = 'complete', outcome = 'pass'").run();
  transitionRun(db, r.run_id, "validated");
  m = matchAuthorization(db, here);
  assert(m.matched && m.next === "pr" && m.latest_attempt?.outcome === "pass", "a validated run: next is pr");
  transitionRun(db, r.run_id, "pr_open");
  db.prepare("UPDATE factory_runs SET pr_number = 12 WHERE run_id = ?").run(r.run_id);
  m = matchAuthorization(db, here);
  assert(m.matched && m.next === "refresh_pr" && m.pr_number === 12, "a run with an open PR: next is refresh_pr, with its number");
  const at = (status: string, outcome: string | null = null) => ({ attempt: 1, status, outcome, head_sha: "x" });
  assert(nextStep("implementing", at("interrupted")) === "implement", "implementing after an interrupted attempt: implement");
  assert(nextStep("validating", at("interrupted")) === "validate", "validating after an interrupted attempt (a crash during checks): validate again");
  assert(nextStep("validating", null) === "validate", "validating with no attempt allocated: validate");
  assert(nextStep("validating", at("finalizing")) === "resume", "an attempt left finalizing (a crash while recording the review): resume");
  assert(nextStep("validating", at("complete", "pass")) === "resume", "a complete attempt whose run transition is owed: resume");

  transitionRun(db, r.run_id, "escalated", { reason: "test" });
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "run_halted" && m.state === "escalated", "an escalated run waits on a human: run_halted");
  transitionRun(db, r.run_id, "closed", { action: "abandoned" });
  m = matchAuthorization(db, here);
  assert(!m.matched && m.reasons.join() === "no_run", "a closed run is no run");

  console.log("\nthe fix handoff (#92)\n");
  {
    const r2 = startRun(db, { workItem: "acme/w#42", ctx });
    approveRun(db, r2.run_id, { contractFile: contractFor(r2.run_id), budgetMs: HOUR });
    m = matchAuthorization(db, here);
    assert(m.matched && m.fix === null, "an approved run has nothing to fix yet");
    transitionRun(db, r2.run_id, "implementing");
    transitionRun(db, r2.run_id, "validating");
    const findings = [
      { id: "evidence:AC-1.e1", severity: "blocking", detail: "test.ts::works: failed: expected 401", evidence_digest: "sha256:" + "a".repeat(64) },
      { id: "review:1", severity: "blocking", detail: "the diagram shows an edge the code never takes", location: "README.md" },
      { id: "assertion:test.ts:3", severity: "advisory", detail: "modified assertion" },
    ];
    db.prepare(
      `INSERT INTO factory_attempts (run_id, attempt, status, outcome, head_sha, contract_digest, policy_version, findings_json, report_path, started_at)
         VALUES (?, 1, 'complete', 'fail', 'abc', ?, 'p', ?, '/art/attempts/1/report.json', 'now')`,
    ).run(r2.run_id, getRun(db, r2.run_id).contract_digest, JSON.stringify(findings));
    transitionRun(db, r2.run_id, "implementing", { reason: "attempt 1: fail; fix_loop" });
    m = matchAuthorization(db, here);
    assert(
      m.matched && m.next === "implement" && m.fix?.attempt === 1 && m.fix.outcome === "fail" &&
        m.fix.blocking_findings.map((f) => f.id).join() === "evidence:AC-1.e1,review:1" &&
        m.fix.blocking_findings[1].location === "README.md" && m.fix.report_path === "/art/attempts/1/report.json",
      "an implementing run after a fail carries the blocking findings",
    );
    db.prepare("UPDATE factory_attempts SET outcome = 'error', error_cause = 'code', error_reason = 'verify timeout' WHERE run_id = ?").run(r2.run_id);
    m = matchAuthorization(db, here);
    assert(m.matched && m.fix?.outcome === "error" && m.fix.error?.cause === "code" && m.fix.error.reason === "verify timeout", "and after an error, its cause");
    transitionRun(db, r2.run_id, "validating");
    m = matchAuthorization(db, here);
    assert(m.matched && m.fix === null, "once validation starts again, there's no handoff");
    transitionRun(db, r2.run_id, "closed", { action: "abandoned" });
  }

  db.close();
  cleanup();
  console.log("\nAll authorization tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
