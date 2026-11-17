import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { validateRun, type Report } from "./factory/validate.ts";
import { getRun, getAttempt, transitionAttempt } from "./factory/state.ts";
import { schemaErrors } from "./factory/schemas.ts";
import { assert, tempDir, sh, cleanup } from "./factory/testkit.ts";
import { owner, SETTINGS, junit, PASSING, TEST_FILE, TEST_EV, write, commit, project } from "./factory/fixtures.ts";

const validate = (db: Database, runId: string) => validateRun(db, runId, { owner, lockWaitMs: 5_000, graceMs: 200 });

function report(path: string): Report {
  const r = JSON.parse(readFileSync(path, "utf-8"));
  assert(schemaErrors("report", r).length === 0, `report validates against report.schema.json (${r.status}/${r.outcome})`);
  return r;
}

async function run() {
  console.log("A passing attempt\n");
  {
    const { db, root, run } = await project({});
    const r = await validate(db, run.run_id);
    assert(r.status === "awaiting_review" && r.outcome === null && r.attempt === 1, "all deterministic phases pass → awaiting_review, no outcome yet");
    assert(r.run_state === "validating" && getRun(db, run.run_id).state === "validating", "the run is validating");
    const rep = report(r.report_path);
    assert(rep.head_sha === sh("git", ["rev-parse", "HEAD"], root) && rep.target_ref === "main", "the report records the head and target");
    assert(rep.merge_base_sha === sh("git", ["rev-parse", "main"], root) && rep.target_sha === rep.merge_base_sha, "and the merge base");
    assert(/^factory@\d+\.\d+\.\d+\+settings:sha256:[0-9a-f]{64}$/.test(rep.policy_version), "policy_version is runner version + settings digest");
    assert(rep.phases.map((p) => `${p.name}:${p.outcome}`).join() === "static:pass,evidence:pass", "static and evidence pass");
    assert(rep.evidence[0].executed === "passed" && rep.evidence[0].supports_criterion === null, "evidence passed, awaiting the reviewer's judgment");
    const verify = rep.invocations.find((i) => i.phase === "verify")!;
    assert(verify.results?.length === 1 && /^sha256:/.test(verify.results[0].digest), "the results file is recorded with its digest and invocation");
    assert(verify.results![0].path === `results/${verify.id}/junit.xml`, "in the invocation's own results directory");
    assert(existsSync(join(dirname(r.report_path), verify.log)), "logs are kept under the attempt dir");
    assert(rep.tree_clean_after && rep.tier.actual === "standard" && rep.validation_scope === "branch", "clean after, standard tier, branch scope");
    const a = getAttempt(db, run.run_id, 1);
    assert(a.status === "awaiting_review" && a.report_path === r.report_path && a.owner_json === null, "the attempt row points at the report");
    await throws_(() => validate(db, run.run_id), /attempt_open/, "a second validate waits for the review");
  }

  console.log("\nPreconditions (blocked, nothing changes)\n");
  {
    const { db, root, run } = await project({});
    writeFileSync(join(root, "SCRATCHPAD_7.md"), "notes\n");
    await throws_(() => validate(db, run.run_id), /dirty_tree.*SCRATCHPAD_7\.md.*\.git\/info\/exclude/, "an untracked scratchpad blocks validation, naming the fix");
    const attempts = (db.prepare("SELECT COUNT(*) AS n FROM factory_attempts").get() as { n: number }).n;
    assert(attempts === 0 && getRun(db, run.run_id).state === "approved", "no attempt is used and the run keeps its state");
    appendFileSync(join(root, ".git", "info", "exclude"), "SCRATCHPAD_*.md\n");
    assert((await validate(db, run.run_id)).status === "awaiting_review", "listed in .git/info/exclude, it validates");
  }
  {
    const { db, run } = await project({});
    appendFileSync(join(run.artifact_dir, "contract.json"), " ");
    await throws_(() => validate(db, run.run_id), /contract_mismatch/, "a changed contract file is blocked");
  }
  {
    const { db, run } = await project({ settings: SETTINGS.replace(/- \*\*verify\*\*.*\n/, "") });
    await throws_(() => validate(db, run.run_id), /not_configured.*verify/, "a required check without a command is blocked");
  }
  {
    const { db, run } = await project({ settings: SETTINGS + "- **max-attempts**: lots\n" });
    await throws_(() => validate(db, run.run_id), /bad_setting.*max-attempts/, "invalid settings are blocked");
  }

  console.log("\nResults without file paths (node:test)\n");
  {
    const NODE = '<testsuites>\n<testcase name="rejects expired" classname="test"/>\n<testcase name="refreshes" classname="test"/>\n</testsuites>\n';
    const { db, run } = await project({ branch: { "ci/junit.xml": NODE } });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(r.status === "awaiting_review" && rep.evidence[0].executed === "passed", "top-level testcases count, and the selector matches by name");
    assert(rep.flags.some((f) => f.startsWith("evidence AC-1.e1: tests/auth.test.ts::rejects expired matched by test name only")), "the report flags the name-only match for the reviewer");
  }
  {
    const NODE = '<testsuites><testcase name="rejects expired" classname="test"/></testsuites>\n';
    const { db, run } = await project({ branch: { "ci/junit.xml": NODE }, evidence: [{ ...TEST_EV, selector: "tests/missing.test.ts::rejects expired" }] });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.evidence[0].executed === "not_found", "a selector naming a file that doesn't exist at head never matches by name");
  }

  console.log("\nFailures complete the attempt\n");
  {
    const { db, run } = await project({ branch: { "ci/junit.xml": junit([{ name: "auth rejects expired", status: "failed" }]), "ci/verify-exit": "1\n" } });
    const r = await validate(db, run.run_id);
    assert(r.status === "complete" && r.outcome === "fail" && r.failed_phase === "evidence", "a failing evidence test fails the attempt");
    assert(r.run_state === "escalated", "and escalates the run (no fix loop yet)");
    const rep = report(r.report_path);
    const f = rep.findings.find((x) => x.id === "evidence:AC-1.e1")!;
    assert(f.severity === "blocking" && f.detail.includes("expected 401") && /^sha256:/.test(f.evidence_digest!), "a blocking finding with the failure and its digest");
    assert(rep.evidence[0].executed === "failed" && rep.evidence[0].excerpt === "expected 401, got 500", "the evidence records the failure");
  }
  {
    const { db, run } = await project({ evidence: [{ ...TEST_EV, selector: "tests/auth.test.ts::no such test" }] });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.evidence[0].executed === "not_found", "a selector matching no executed test is not_found, a failure");
  }
  {
    const { db, run } = await project({ branch: { "ci/junit.xml": junit([{ name: "auth rejects expired", status: "skipped" }, { name: "x" }]) } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.evidence[0].executed === "skipped", "a skipped evidence test is a failure");
  }
  {
    const { db, run } = await project({ branch: { "ci/static-exit": "2\n" } });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(r.outcome === "fail" && r.failed_phase === "static" && rep.phases.length === 1, "a static failure stops before evidence");
    assert(rep.evidence[0].executed === "not_run" && rep.findings.some((f) => f.id === "check:static"), "evidence is not_run");
  }
  {
    const { db, run } = await project({ branch: { "ci/verify-exit": "1\n" } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.evidence[0].executed === "passed", "verify failing elsewhere fails the phase, though the evidence passed");
  }

  console.log("\nResult freshness (§4.4)\n");
  {
    const { db, run } = await project({ branch: { "ci/verify.sh": "exit 0\n" } });
    // Results planted where an attempt would write them are never read.
    mkdirSync(join(run.artifact_dir, "attempts", "1", "results", "2-verify"), { recursive: true });
    writeFileSync(join(run.artifact_dir, "attempts", "1", "results", "2-verify", "junit.xml"), PASSING);
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(r.outcome === "error" && rep.findings.some((f) => f.detail.includes("wrote no results")), "stale results in the attempt's results dir can't produce a pass");
  }
  {
    const settings = SETTINGS.replace("junit:$FACTORY_RESULTS_DIR/junit.xml", "junit:out/junit.xml");
    const { db, root, run } = await project({ settings, base: { ".gitignore": "out/\n" }, branch: { "ci/verify.sh": "exit 0\n" } });
    write(root, { "out/junit.xml": PASSING });
    const r = await validate(db, run.run_id);
    assert(r.outcome === "error" && !existsSync(join(root, "out", "junit.xml")), "a stale file at a fixed results path is deleted first and can't produce a pass");
  }
  {
    const settings = SETTINGS.replace("junit:$FACTORY_RESULTS_DIR/junit.xml", "junit:out/junit.xml");
    const { db, run } = await project({
      settings,
      base: { ".gitignore": "out/\n" },
      branch: { "ci/verify.sh": "mkdir -p out && cp ci/junit.xml out/junit.xml\n" },
    });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    const v = rep.invocations.find((i) => i.phase === "verify")!;
    assert(r.status === "awaiting_review" && v.results![0].path === `results/${v.id}/fixed`, "fresh results at a fixed path are copied into the attempt");
  }
  {
    const { db, run } = await project({ branch: { "ci/junit.xml": "<testsuites><testsuite name=\"empty\"/></testsuites>\n" } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "error" && rep.findings.some((f) => f.detail.includes("zero executed tests")), "zero executed tests is an error, never a pass");
  }

  console.log("\nIdentity post-check (§4.3)\n");
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "echo touched >> README.md\n" } });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(r.outcome === "error" && !rep.tree_clean_after, "a check that modifies a tracked file is an error");
    assert(rep.findings.some((f) => f.id === "identity" && f.detail.startsWith("checks are not side-effect free")), "named as a side effect");
  }
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "git commit -q --allow-empty -m sneaky\n" } });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(r.outcome === "error" && rep.tree_clean_after, "a check that moves HEAD (tree still clean) is an error");
    assert(rep.findings.some((f) => f.detail.startsWith("revision changed during validation")), "named as a revision change");
  }

  console.log("\nError causes (§5.4)\n");
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "sleep 5\n" } });
    const r = await validateRun(db, run.run_id, { owner, lockWaitMs: 5_000, graceMs: 200, timeoutMs: 300 });
    const rep = report(r.report_path);
    const a = getAttempt(db, run.run_id, 1);
    assert(
      r.outcome === "error" && rep.error?.cause === "code" && rep.error.reason === "static timeout" && a.error_cause === "code" && r.error?.cause === "code",
      "a timed-out check records error cause code",
    );
  }
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "git commit -q --allow-empty -m sneaky\n" } });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(
      r.outcome === "error" && rep.error?.cause === "run" && getAttempt(db, run.run_id, 1).error_reason === "revision changed during validation",
      "a revision change during validation records error cause run",
    );
  }
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "echo touched >> README.md\n" } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.error?.cause === "code" && rep.error.reason === "checks are not side-effect free", "checks that write into the tree are the code's error");
  }
  {
    const { db, run } = await project({ branch: { "ci/junit.xml": "<testsuites><testsuite name=\"empty\"/></testsuites>\n" } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.error?.cause === "code", "test results the change broke are the code's error");
  }
  {
    const { db, run } = await project({
      evidence: [{ id: "AC-1.e1", type: "command", kind: "new_behavior", run: "true", cwd: "no-such-dir", expect: { exit_code: 0 } }],
    });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(
      r.outcome === "error" && rep.error?.cause === "environment" && rep.error.reason.includes("spawn_failed") && getAttempt(db, run.run_id, 1).error_cause === "environment",
      "a check that cannot start records error cause environment",
    );
  }
  {
    const { db, run } = await project({ settings: SETTINGS + "- **setup**: exit 5\n" });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.error?.cause === "environment" && rep.error.reason === "setup failed (exit 5)", "a failed setup is the environment's error");
  }
  {
    const { db, run } = await project({ branch: { "ci/static-exit": "2\n" } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.error === undefined && getAttempt(db, run.run_id, 1).error_cause === null, "a fail has no error cause");
  }

  console.log("\nRegression flags (§6.2)\n");
  {
    const { db, root, run } = await project({});
    const first = await validate(db, run.run_id);
    assert(report(first.report_path).evidence[0].executed === "passed", "attempt 1: the evidence passes");
    transitionAttempt(db, run.run_id, 1, "finalizing");
    transitionAttempt(db, run.run_id, 1, "complete", { outcome: "fail" });
    commit(root, { "ci/junit.xml": junit([{ name: "auth rejects expired", status: "failed" }]), "ci/verify-exit": "1\n" });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(
      rep.outcome === "fail" && rep.flags.includes("regression: evidence AC-1.e1 passed in attempt 1 and is failed now"),
      "evidence that passed in an earlier attempt and fails now is flagged regression",
    );
  }
  {
    const { db, run } = await project({ branch: { "ci/junit.xml": junit([{ name: "auth rejects expired", status: "failed" }]) } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(!rep.flags.some((f) => f.startsWith("regression")), "evidence that never passed is not a regression");
  }

  console.log("\nTier and classification\n");
  {
    const { db, run } = await project({ branch: { "src/auth/token.ts": "export const t = 1;\n" } });
    const r = await validate(db, run.run_id);
    assert(r.tier.proposed === "standard" && r.tier.actual === "sensitive", "a sensitive path in the actual diff raises the tier regardless of the plan");
    assert(r.tier.reasons.includes("sensitive path: src/auth/token.ts (matches src/auth/**)"), "with the reason");
    assert(getRun(db, run.run_id).tier_actual === "sensitive", "recorded on the run");
  }
  {
    const { db, run } = await project({
      branch: {
        "tests/auth.test.ts": TEST_FILE.replace("toBe(200)", "toBe(201)") + "\nit('rejects expired', () => {\n  expect(refresh(old)).toBe(401);\n});\n",
        "tests/new.test.ts": "it('new', () => {});\n",
      },
    });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.changes.new_evidence === 2 && rep.changes.modified_assertions === 1, "new tests are new evidence; an edited assertion is modified");
    const f = rep.findings.find((x) => x.id.startsWith("assertion:"))!;
    assert(f.location === "tests/auth.test.ts:2" && f.severity === "advisory", "each modified assertion is an advisory finding the reviewer must justify");
    assert(rep.status === "awaiting_review", "modified assertions don't fail the deterministic phases");
  }
  {
    const { db, run } = await project({ branch: { "CLAUDE.md": SETTINGS.replace("src/auth/**", "src/none/**") } });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.changes.execution_policy === 1 && rep.tier.actual === "sensitive", "changed factory settings are an execution-policy change → sensitive");
    assert(rep.tier.reasons.some((x) => x.includes("factory settings changed")), "with the reason");
  }
  {
    const { db, run } = await project({
      branch: { "src/auth/token.ts": "x\n" },
      settings: SETTINGS,
      contract: { predicted_files: ["src/app.ts", "src/other.ts"] },
    });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.flags.join(" | ") === "drift: changed but not predicted: src/auth/token.ts | drift: predicted but unchanged: src/other.ts", "predicted-vs-actual drift is a flag");
  }

  console.log("\nCommand and manual evidence\n");
  {
    const { db, run } = await project({
      evidence: [
        { id: "AC-1.e1", type: "command", kind: "new_behavior", run: "grep -c app src/app.ts", expect: { exit_code: 0, stdout_matches: "^1$" } },
        { id: "AC-1.e2", type: "manual", kind: "new_behavior", instructions: "Look at it" },
      ],
    });
    const r = await validate(db, run.run_id);
    const rep = report(r.report_path);
    assert(rep.evidence.map((e) => e.executed).join() === "passed,pending_manual", "command evidence runs on its own; manual evidence is pending");
    assert(rep.phases[1].outcome === "pending_manual" && r.status === "awaiting_review", "the evidence phase is pending_manual, awaiting review");
  }
  {
    const { db, run } = await project({
      evidence: [{ id: "AC-1.e1", type: "command", kind: "new_behavior", run: "echo nope", expect: { exit_code: 0, stdout_not_matches: "nope" } }],
    });
    const rep = report((await validate(db, run.run_id)).report_path);
    assert(rep.outcome === "fail" && rep.findings[0].detail.includes("stdout matches /nope/"), "an unmet expectation fails the evidence");
  }

  console.log("\nSetup policy (§4.3)\n");
  {
    const counter = join(tempDir(), "setups");
    const settings = SETTINGS + `- **setup**: echo run >> ${counter}\n`;
    const { db, root, run } = await project({ settings });
    const setups = () => (existsSync(counter) ? readFileSync(counter, "utf-8").split("\n").filter(Boolean).length : 0);
    const reviewDone = (n: number) => {
      transitionAttempt(db, run.run_id, n, "finalizing");
      transitionAttempt(db, run.run_id, n, "complete", { outcome: "pass" });
    };
    await validate(db, run.run_id);
    assert(setups() === 1, "the first attempt runs setup");
    reviewDone(1);
    await validate(db, run.run_id);
    assert(setups() === 1, "an unchanged lockfile doesn't run it again");
    reviewDone(2);
    commit(root, { "package-lock.json": "{}\n" });
    const r3 = await validate(db, run.run_id);
    assert(setups() === 2 && report(r3.report_path).lockfile_digest !== null, "a changed lockfile runs setup again");
    reviewDone(3);
    await throws_(() => validate(db, run.run_id), /attempt_budget/, "max-attempts (3) is enforced before anything runs");
  }
  {
    const { db, run } = await project({ settings: SETTINGS + "- **setup**: exit 5\n" });
    const r = await validate(db, run.run_id);
    assert(r.outcome === "error" && r.failed_phase === "static", "a failed setup is an error");
  }

  console.log("\nAll factory validate tests passed.");
}

async function throws_(fn: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ""} ${String(err)}`;
    assert(pattern.test(text), `${msg} (${String(err)})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

try {
  await run();
} finally {
  cleanup();
}
