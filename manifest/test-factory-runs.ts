import { readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectContext } from "./factory/context.ts";
import {
  startRun,
  approveRun,
  revokeRun,
  escalateRun,
  runStatus,
  listRuns,
  requireExecutable,
  runIdBase,
  issueNumberOf,
  contractDigest,
} from "./factory/runs.ts";
import { getRun, transitionRun, transitionAttempt, type AttemptError } from "./factory/state.ts";
import { allocateAttempt } from "./factory/attempts.ts";
import { continueRun } from "./factory/fixloop.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, throws, tempDir, cleanup, makeRepo, memDb, contractJson, contractFor } from "./factory/testkit.ts";

const HOUR = 3_600_000;

function auths(db: import("better-sqlite3").Database, runId: string) {
  return db
    .prepare("SELECT contract_digest, status FROM factory_authorizations WHERE run_id = ? ORDER BY approved_at, contract_digest")
    .all(runId) as { contract_digest: string; status: string }[];
}

async function run() {
  console.log("Run identity\n");

  assert(runIdBase("#42") === "#42", "#42 stays as is");
  assert(runIdBase("fusupo/escapement#42") === "fusupo-escapement#42", "a slash becomes a dash");
  assert(runIdBase("  Studio item: 17 ") === "Studio-item-17", "spaces and punctuation are collapsed");
  throws(() => runIdBase("///"), /bad_work_item/, "a work item with nothing usable is rejected");
  assert(issueNumberOf("#42") === 42 && issueNumberOf("o/r#7") === 7, "issue numbers are read from #N and owner/repo#N");
  assert(issueNumberOf("STUDIO-12") === null, "other identifiers have no issue number");

  console.log("\nstart\n");
  const db = await memDb();
  const ctxDir = tempDir();
  const root = realpathSync(
    makeRepo({ branch: "42-x", origin: "git@github.com:acme/w.git", claudeMd: `## Escapement Settings\n\n- **context-path**: ${ctxDir}\n` }),
  );
  const ctx = projectContext(root);

  const r1 = startRun(db, { workItem: "acme/w#42", ctx });
  assert(r1.run_id === "acme-w#42-r1" && r1.state === "planned", "start creates run r1 in planned");
  assert(r1.issue_number === 42 && r1.repo === "acme/w" && r1.branch === "42-x", "run records issue, repo and branch");
  assert(r1.worktree_path === root && r1.target_ref === "main", "run is bound to the worktree, with a default target");
  assert(r1.artifact_source === "context-path" && existsSync(r1.artifact_dir), "the artifact dir is created under context-path");
  throws(() => startRun(db, { workItem: "acme/w#42", ctx }), /run_exists/, "a worktree can have only one open run");

  const ext = startRun(db, {
    workItem: "STUDIO-12",
    ctx: { ...ctx, worktreePath: "/elsewhere" },
    artifactDir: tempDir(),
    manifestId: "m-1",
    targetRef: "develop",
    workType: "bug",
  });
  assert(ext.run_id === "STUDIO-12-r1" && ext.issue_number === null, "an external work item needs no issue or work_items row");
  assert(ext.manifest_id === "m-1" && ext.target_ref === "develop" && ext.work_type === "bug", "optional fields are recorded");
  assert(ext.artifact_source === "flag", "--artifact-dir is honoured");

  const based = realpathSync(makeRepo({ claudeMd: "## Escapement Settings\n\n- **base-branch**: trunk\n" }));
  const db2 = await memDb();
  const rb = startRun(db2, { workItem: "#5", ctx: projectContext(based), artifactDir: tempDir() });
  assert(rb.target_ref === "trunk", "without --target-ref, the base-branch setting is the target");

  const onMain = realpathSync(makeRepo({ branch: "main" }));
  const art = tempDir();
  throws(
    () => startRun(db2, { workItem: "#6", ctx: projectContext(onMain), artifactDir: art }),
    /on_target_branch/,
    "start refuses when the worktree is on the target branch (default target)",
  );
  throws(
    () => startRun(db2, { workItem: "#6", ctx: projectContext(based), artifactDir: art, targetRef: "origin/1-work" }),
    /on_target_branch/,
    "and when --target-ref names the current branch through origin/",
  );
  const refused = db2.prepare("SELECT COUNT(*) AS n FROM factory_runs WHERE work_item = '#6'").get() as { n: number };
  assert(refused.n === 0 && !existsSync(join(art, "#6-r1")), "a refused start creates no run and no artifact dir");
  db2.close();

  console.log("\napprove\n");
  const contract = join(tempDir(), "contract.json");
  const first = contractJson(r1.run_id);
  writeFileSync(contract, first);
  const before = Date.now();
  const a1 = approveRun(db, r1.run_id, { contractFile: contract, budgetMs: 2 * HOUR });
  assert(a1.run.state === "approved" && a1.changed, "approve moves planned to approved");
  assert(a1.run.tier_proposed === "standard", "the run records the contract's proposed tier");
  assert(a1.authorization.status === "active" && a1.authorization.contract_digest === contractDigest(first), "an active authorization holds the contract digest");
  assert(JSON.parse(a1.authorization.authorizes_json).includes("commit"), "the authorization lists what it allows");
  assert(readFileSync(join(r1.artifact_dir, "contract.json"), "utf-8") === first, "the contract is copied to the artifact dir");
  const deadline = Date.parse(a1.run.deadline_at!);
  assert(deadline >= before + 2 * HOUR && deadline <= Date.now() + 2 * HOUR, "deadline_at is approved_at plus the budget");

  const again = approveRun(db, r1.run_id, { contractFile: contract, budgetMs: 2 * HOUR });
  assert(!again.changed && auths(db, r1.run_id).length === 1, "re-approving the same contract changes nothing");

  writeFileSync(contract, contractJson(r1.run_id, { predicted_files: ["src/a.ts"], risk_tier_proposed: "sensitive", risk_reasons: ["auth"] }));
  const a2 = approveRun(db, r1.run_id, { contractFile: contract, budgetMs: 10 * HOUR });
  const statuses = auths(db, r1.run_id).map((a) => a.status).sort().join(",");
  assert(a2.changed && a2.superseded === a1.authorization.contract_digest, "a changed contract supersedes the old authorization");
  assert(statuses === "active,superseded", "one active and one superseded authorization remain");
  assert(getRun(db, r1.run_id).deadline_at === a1.run.deadline_at, "re-approval doesn't move the deadline");
  assert(getRun(db, r1.run_id).contract_digest === a2.authorization.contract_digest, "the run records the current contract digest");
  assert(getRun(db, r1.run_id).tier_proposed === "sensitive", "and the current contract's proposed tier");
  throws(() => approveRun(db, r1.run_id, { contractFile: "/no/such/file", budgetMs: HOUR }), /no_contract/, "a missing contract file is an error");
  throws(() => approveRun(db, r1.run_id, { contractFile: contractFor("#42-r9"), budgetMs: HOUR }), /bad_contract.*not acme-w#42-r1/, "a contract for another run is rejected");
  throws(() => approveRun(db, r1.run_id, { contractFile: contractFor(r1.run_id, { issue: 7 }), budgetMs: HOUR }), /bad_contract.*issue 7/, "a contract naming another issue is rejected");
  const invalid = join(tempDir(), "bad.json");
  writeFileSync(invalid, JSON.stringify({ version: 1, run_id: r1.run_id, risk_tier_proposed: "standard", criteria: [], commands: { verify: "true" } }));
  throws(() => approveRun(db, r1.run_id, { contractFile: invalid, budgetMs: HOUR }), /bad_contract(?=[\s\S]*\/criteria)(?=[\s\S]*"commands")/, "an invalid contract is rejected with every problem");
  assert(auths(db, r1.run_id).filter((a) => a.status === "active").length === 1, "a rejected contract leaves the authorization alone");
  const nulls = contractFor(r1.run_id, { issue: null, manifest_id: null });
  assert(approveRun(db, r1.run_id, { contractFile: nulls, budgetMs: HOUR }).changed, "issue and manifest_id may be null");
  approveRun(db, r1.run_id, { contractFile: contract, budgetMs: HOUR });

  console.log("\nrevoke and the authorization lifecycle\n");
  const rev = revokeRun(db, r1.run_id);
  assert(rev.status === "revoked" && rev.ended_at !== null, "revoke ends the active authorization as revoked");
  throws(() => revokeRun(db, r1.run_id), /no_active_authorization/, "revoking twice is an error");
  throws(() => requireExecutable(db, r1.run_id), /not_authorized/, "a revoked run can't execute");
  approveRun(db, r1.run_id, { contractFile: contract, budgetMs: HOUR });
  assert(requireExecutable(db, r1.run_id).authorization.status === "active", "re-approval restores an active authorization");
  transitionRun(db, r1.run_id, "closed", { action: "abandoned" });
  const final = auths(db, r1.run_id).map((a) => a.status).sort().join(",");
  assert(final === "ended,superseded,superseded", "closing the run ends the authorization (active → ended)");
  throws(() => approveRun(db, r1.run_id, { contractFile: contract, budgetMs: HOUR }), /wrong_state/, "a closed run can't be approved");

  console.log("\nrun deadline\n");
  const r2 = startRun(db, { workItem: "#42", ctx });
  assert(r2.run_id === "#42-r1", "after closing, the worktree can start a new run");
  approveRun(db, r2.run_id, { contractFile: contractFor(r2.run_id), budgetMs: HOUR });
  db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), r2.run_id);
  throws(() => requireExecutable(db, r2.run_id), /run_deadline/, "past the deadline, execution is blocked");
  assert(getRun(db, r2.run_id).state === "escalated", "the run is escalated with reason run_deadline");
  const st = runStatus(db, r2.run_id);
  assert(st.deadline_passed && st.run.state_reason === "run_deadline", "status still works past the deadline");
  assert(revokeRun(db, r2.run_id).status === "revoked", "revoke still works past the deadline");

  console.log("\nstatus\n");
  const open = listRuns(db).map((r) => r.run_id).join(",");
  assert(open === "STUDIO-12-r1,#42-r1", "status lists open runs");
  assert(listRuns(db, { all: true }).length === 3, "status --all includes closed runs");
  assert(st.authorizations.length === 1 && Array.isArray(st.authorizations[0].authorizes), "run status lists authorizations");

  console.log("\nescalate\n");
  const e = startRun(db, { workItem: "#77", ctx: { ...ctx, worktreePath: "/esc" }, artifactDir: tempDir() });
  throws(() => escalateRun(db, e.run_id, { reason: "  " }), /usage/, "escalate needs a reason");
  approveRun(db, e.run_id, { contractFile: contractFor(e.run_id), budgetMs: HOUR });
  let esc = escalateRun(db, e.run_id, { reason: "validate blocked: dirty_tree" });
  assert(esc.changed && esc.run.state === "escalated" && esc.run.state_reason === "validate blocked: dirty_tree", "escalate halts the run with the reason");
  esc = escalateRun(db, e.run_id, { reason: "again" });
  assert(!esc.changed && esc.run.state_reason === "validate blocked: dirty_tree", "escalating an escalated run changes nothing");
  transitionRun(db, e.run_id, "closed", { action: "abandoned" });
  throws(() => escalateRun(db, e.run_id, { reason: "x" }), /run_closed/, "a closed run can't be escalated");

  console.log("\ncontinue (#92)\n");
  {
    const owner = currentOwner("test continue");
    let n = 0;
    /** An approved run, validated `outcomes.length` times, then escalated. */
    const escalatedAfter = (outcomes: [string, AttemptError?][]) => {
      const r = startRun(db, { workItem: `#9${++n}`, ctx: { ...ctx, worktreePath: `/cont${n}` }, artifactDir: tempDir() });
      approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
      transitionRun(db, r.run_id, "implementing");
      for (const [outcome, error] of outcomes) {
        if (getRun(db, r.run_id).state === "implementing") transitionRun(db, r.run_id, "validating");
        const a = allocateAttempt(db, r.run_id, { owner, headSha: "abc", contractDigest: getRun(db, r.run_id).contract_digest!, policyVersion: "p" });
        transitionAttempt(db, r.run_id, a.attempt, "complete", { outcome, error });
      }
      transitionRun(db, r.run_id, "escalated", { reason: "attempt: needs the operator" });
      return getRun(db, r.run_id);
    };

    const before = escalatedAfter([["error", { cause: "environment", reason: "verify was stopped (spawn_failed)" }]]);
    const c = continueRun(db, before.run_id, { reason: "installed node", owner, maxAttempts: 3 });
    const after = getRun(db, before.run_id);
    const active = runStatus(db, before.run_id).authorization;
    assert(
      c.changed && after.state === "implementing" && after.state_reason === "continue: installed node" &&
        after.contract_digest === before.contract_digest && active?.contract_digest === before.contract_digest &&
        active?.approved_at !== undefined && after.deadline_at === before.deadline_at && c.attempts_used === 1,
      "continue keeps the contract digest, authorization and deadline",
    );
    assert(c.attempt === 1 && c.outcome === "error" && c.error?.cause === "environment", "it names the attempt to fix, with its error");
    const again = continueRun(db, before.run_id, { reason: "twice", owner, maxAttempts: 3 });
    assert(!again.changed && getRun(db, before.run_id).state_reason === "continue: installed node", "continuing twice changes nothing");
    const a2 = allocateAttempt(db, before.run_id, { owner, headSha: "def", contractDigest: before.contract_digest!, policyVersion: "p", maxAttempts: 3 });
    assert(a2.attempt === 2, "the next validation is a new attempt");

    const late = escalatedAfter([["fail"]]);
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), late.run_id);
    throws(() => continueRun(db, late.run_id, { reason: "x", maxAttempts: 3 }), /run_deadline/, "continue is refused past the deadline");
    assert(getRun(db, late.run_id).state === "escalated", "and the run stays escalated");

    const spent = escalatedAfter([["fail"], ["fail"]]);
    throws(() => continueRun(db, spent.run_id, { reason: "x", maxAttempts: 2 }), /attempt_budget/, "continue is refused when the attempt budget is used up");

    const passed = escalatedAfter([["pass"]]);
    throws(() => continueRun(db, passed.run_id, { reason: "x", maxAttempts: 3 }), /no_failed_attempt/, "continue is refused when the latest attempt did not fail or error");
    const none = escalatedAfter([]);
    throws(() => continueRun(db, none.run_id, { reason: "x", maxAttempts: 3 }), /no_failed_attempt/, "and when there is no attempt");

    const revoked = escalatedAfter([["fail"]]);
    revokeRun(db, revoked.run_id);
    throws(() => continueRun(db, revoked.run_id, { reason: "x", maxAttempts: 3 }), /not_authorized/, "and without an active authorization");
    const changedContract = escalatedAfter([["fail"]]);
    writeFileSync(join(changedContract.artifact_dir, "contract.json"), contractJson(changedContract.run_id, { risk_tier_proposed: "sensitive" }));
    throws(() => continueRun(db, changedContract.run_id, { reason: "x", maxAttempts: 3 }), /contract_mismatch/, "and when the contract changed");
    throws(() => continueRun(db, changedContract.run_id, { reason: " ", maxAttempts: 3 }), /usage/, "continue needs a reason");
    const blockedRun = escalatedAfter([["fail"]]);
    db.prepare("UPDATE factory_runs SET state = 'blocked' WHERE run_id = ?").run(blockedRun.run_id);
    throws(() => continueRun(db, blockedRun.run_id, { reason: "x", maxAttempts: 3 }), /wrong_state/, "a blocked run can't continue (only escalated)");
  }

  db.close();
  console.log("\nAll factory run tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
