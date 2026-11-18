import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkReadiness, readinessText } from "./factory/readiness.ts";
import { schemaErrors } from "./factory/schemas.ts";
import { assert, tempDir, cleanup, contractJson } from "./factory/testkit.ts";

const CONFIGURED = `## Escapement Settings

- **static**: npm run lint
- **verify**: npx jest --runInBand
- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml
- **sensitive-paths**: src/auth/**
`;

function project(claudeMd: string | null): string {
  const dir = tempDir();
  if (claudeMd !== null) writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  return dir;
}

function check(contractText: string | null | undefined, dir: string) {
  const r = checkReadiness({ contractText, source: "contract.json", projectDir: dir });
  assert(schemaErrors("readiness", r).length === 0, `output validates against readiness.schema.json (${r.status})`);
  return r;
}

function run() {
  console.log("Readiness check\n");

  {
    const r = check(contractJson("#1-r1"), project(CONFIGURED));
    assert(r.status === "ready" && r.questions.length === 0, "a valid contract in a configured project is ready");
    assert(r.required_checks.map((c) => `${c.name}=${c.command}`).join() === "static=npm run lint,verify=npx jest --runInBand", "it lists the required checks with their commands");
    assert(r.tier?.tier === "standard" && /^sha256:/.test(r.settings_digest), "it reports the tier and the settings digest");
    assert(r.target_ref === "main", "and the default target branch (main without origin/develop)");
    const based = check(undefined, project(CONFIGURED + "- **base-branch**: trunk\n"));
    assert(based.target_ref === "trunk", "the base-branch setting is the target branch");
  }

  {
    const r = check(contractJson("#1-r1", { predicted_files: ["src/auth/token.ts"] }), project(CONFIGURED));
    assert(r.status === "ready" && r.tier?.tier === "sensitive", "predicted files in sensitive-paths make the proposed tier sensitive");
    assert(r.tier!.reasons[0] === "sensitive path: src/auth/token.ts (matches src/auth/**)", "with the reason");
    const p = check(contractJson("#1-r1", { risk_tier_proposed: "sensitive", risk_reasons: ["public API"] }), project(CONFIGURED));
    assert(p.tier?.tier === "sensitive" && p.tier.reasons.join() === "public API", "the planner's proposed tier and reasons are kept");
  }

  {
    const r = check(contractJson("#1-r1"), project(null));
    assert(r.status === "needs_human", "a project without static or verify configured needs a human");
    const refs = r.questions.map((q) => `${q.about}:${q.ref}`).join();
    assert(refs === "settings:static,settings:verify,settings:test-results", "it asks for each missing required command and for test-results");
    assert(r.required_checks.every((c) => c.command === null), "missing commands are null");
  }

  {
    const ready = check(undefined, project(CONFIGURED));
    assert(ready.status === "ready" && ready.tier === undefined, "without a contract, a configured project is ready (settings only, no tier)");
    const bare = check(undefined, project(null));
    const refs = bare.questions.map((q) => `${q.about}:${q.ref}`).join();
    assert(bare.status === "needs_human" && refs === "settings:static,settings:verify", "and an unconfigured one asks for each missing required command, nothing about a contract");
  }

  {
    const manualOnly = contractJson("#1-r1", {
      criteria: [{ id: "AC-1", text: "Docs", evidence: [{ id: "AC-1.e1", type: "manual", kind: "new_behavior", instructions: "Read it" }] }],
    });
    const r = check(manualOnly, project(CONFIGURED.replace(/- \*\*test-results\*\*.*\n/, "")));
    assert(r.status === "ready", "test-results is only needed when the contract has test evidence");
  }

  {
    const noEvidence = contractJson("#1-r1", {
      criteria: [
        { id: "AC-1", text: "Fast", evidence: [] },
        { id: "AC-2", text: "Works", evidence: [{ id: "AC-2.e1", type: "test", kind: "regression", selector: "t.ts::x" }] },
      ],
    });
    const r = check(noEvidence, project(CONFIGURED));
    assert(r.status === "needs_human" && r.questions.length === 1, "a criterion without evidence is a readiness failure (§3.1)");
    assert(r.questions[0].about === "criterion" && r.questions[0].ref === "AC-1", "the question names the criterion");
    assert(r.tier === undefined, "an invalid contract has no tier");

    const none = check(contractJson("#1-r1", { criteria: [] }), project(CONFIGURED));
    assert(none.questions[0].question.startsWith("The contract has no acceptance criteria"), "a contract with no criteria asks what to demonstrate");

    const commands = check(contractJson("#1-r1", { commands: { verify: "true" } }), project(CONFIGURED));
    assert(commands.questions[0].about === "contract" && commands.questions[0].question.includes("contracts name no commands"), "a contract naming commands is a contract question");
  }

  {
    const bad = check("{", project(CONFIGURED));
    assert(bad.status === "needs_human" && bad.questions[0].question.includes("not valid JSON"), "invalid JSON is reported");
    const missing = check(null, project(CONFIGURED));
    assert(missing.questions[0].question.startsWith("Cannot read contract.json"), "an unreadable contract is reported");
  }

  {
    const r = check(contractJson("#1-r1"), project(CONFIGURED + "- **max-attempts**: lots\n- **test-results**: tap:x\n"));
    const settings = r.questions.filter((q) => q.about === "settings").map((q) => q.ref).join();
    assert(settings === "max-attempts", "invalid settings are questions, by key");
    const tr = check(contractJson("#1-r1"), project(CONFIGURED.replace("junit:", "tap:")));
    assert(tr.questions.map((q) => q.ref).join() === "test-results", "an unsupported test-results format is asked about once");
  }

  console.log("\nBrowser tests\n");

  {
    const pw = check(contractJson("#1-r1"), project(CONFIGURED + "- **browser-tests**: playwright\n"));
    const none = check(contractJson("#1-r1"), project(CONFIGURED));
    const bare = check(undefined, project(null));
    assert(
      pw.status === "ready" && pw.browser_tests === "playwright" && none.browser_tests === null && bare.browser_tests === null,
      "check reports the browser-tests setting, null when the project sets none",
    );
    const bad = check(undefined, project(CONFIGURED + "- **browser-tests**: cypress\n"));
    assert(bad.status === "needs_human" && bad.questions.map((q) => q.ref).join() === "browser-tests" && bad.browser_tests === null, "an unsupported browser-tests value is a settings question");
    const withLine = readinessText(pw).split("\n");
    const without = readinessText(none);
    assert(
      withLine.includes("  browser tests: playwright") && withLine[0] === "ready" && !/browser tests/.test(without) && without.split("\n").length === withLine.length - 1,
      "the check text lists browser tests when the project sets them and has no such line when it doesn't",
    );
  }

  console.log("\nAll factory readiness tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
