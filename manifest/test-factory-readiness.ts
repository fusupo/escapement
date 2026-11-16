import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkReadiness } from "./factory/readiness.ts";
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

function check(contractText: string | null, dir: string) {
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

  console.log("\nAll factory readiness tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
