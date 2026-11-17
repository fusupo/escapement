import { existsSync } from "node:fs";
import { SCHEMA_NAMES, schemaPath, schemaErrors, contractErrors, parseContract } from "./factory/schemas.ts";
import { assert, throws } from "./factory/testkit.ts";

const SHA = "a".repeat(40);
const DIGEST = "sha256:" + "b".repeat(64);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** The §5.2 example, without `commands`. */
const CONTRACT = {
  version: 1,
  run_id: "esc#42-r1",
  issue: 42,
  manifest_id: "esc#42",
  risk_tier_proposed: "standard",
  criteria: [
    {
      id: "AC-1",
      text: "Expired refresh tokens return 401",
      evidence: [{ id: "AC-1.e1", type: "test", kind: "new_behavior", selector: "tests/auth/refresh.test.ts::rejects expired token" }],
    },
    {
      id: "AC-2",
      text: "Existing refresh flow still works",
      evidence: [{ id: "AC-2.e1", type: "test", kind: "regression", selector: "tests/auth/refresh.test.ts::refreshes valid token" }],
    },
    {
      id: "AC-3",
      text: "Docs describe the refresh flow",
      evidence: [
        { id: "AC-3.e1", type: "manual", kind: "new_behavior", instructions: "docs/auth.md has a 'Refresh' section matching the new behavior" },
        {
          id: "AC-3.e2",
          type: "command",
          kind: "new_behavior",
          run: "grep -c Refresh docs/auth.md",
          cwd: ".",
          timeout_s: 30,
          expect: { exit_code: 0, stdout_matches: "^[1-9]" },
        },
      ],
    },
  ],
  predicted_files: ["src/auth/refresh.ts", "tests/auth/refresh.test.ts"],
};

function contracts() {
  console.log("Contract schema\n");

  assert(SCHEMA_NAMES.every((n) => existsSync(schemaPath(n))), "every schema is published under schemas/factory/");
  assert(contractErrors(CONTRACT).length === 0, "the §5.2 example validates");

  const external = clone(CONTRACT) as Record<string, unknown>;
  delete external.issue;
  delete external.manifest_id;
  external.run_id = "STUDIO-12-r1";
  assert(contractErrors(external).length === 0, "issue and manifest_id are optional; any run_id scheme is accepted");

  const bad = (mutate: (c: any) => void, expect: string, msg: string) => {
    const c = clone(CONTRACT);
    mutate(c);
    const errors = contractErrors(c);
    assert(errors.some((e) => e.includes(expect)), `${msg} → ${errors.find((e) => e.includes(expect)) ?? errors.join(" | ")}`);
  };

  bad((c) => (c.commands = { narrow_verify: "npm test -- auth" }), 'unexpected property "commands" (contracts name no commands', "a contract can't name commands");
  bad((c) => (c["required-checks"] = "static"), 'unexpected property "required-checks"', "a contract can't narrow required-checks");
  bad((c) => (c.version = 2), "/version: must be 1", "an unknown version is rejected");
  bad((c) => delete c.run_id, '(top level): missing "run_id"', "run_id is required");
  bad((c) => (c.run_id = ""), "/run_id", "run_id can't be empty");
  bad((c) => (c.risk_tier_proposed = "low"), '/risk_tier_proposed: must be one of "standard", "sensitive"', "the tier must be standard or sensitive");
  bad((c) => (c.criteria = []), "/criteria: must NOT have fewer than 1 items", "a contract needs criteria");
  bad((c) => (c.criteria[0].evidence = []), "/criteria/0/evidence: must NOT have fewer than 1 items", "every criterion needs evidence");
  bad((c) => (c.criteria[0].evidence[0].type = "vibes"), '/criteria/0/evidence/0/type: must be one of "test", "command", "manual"', "unknown evidence types are rejected");
  bad((c) => (c.criteria[0].evidence[0].kind = "new"), "/criteria/0/evidence/0/kind", "kind must be new_behavior or regression");
  bad((c) => delete c.criteria[0].evidence[0].selector, '/criteria/0/evidence/0: missing "selector"', "test evidence needs a selector");
  bad((c) => (c.criteria[0].evidence[0].run = "npm test"), '/criteria/0/evidence/0: property "run" is not allowed here', "test evidence can't carry a command");
  bad((c) => delete c.criteria[2].evidence[1].expect, '/criteria/2/evidence/1: missing "expect"', "command evidence needs expect");
  bad((c) => delete c.criteria[2].evidence[1].expect.exit_code, '/criteria/2/evidence/1/expect: missing "exit_code"', "expect needs exit_code");
  bad((c) => (c.criteria[2].evidence[1].timeout_s = 0), "/criteria/2/evidence/1/timeout_s", "timeouts are positive");
  bad((c) => delete c.criteria[2].evidence[0].instructions, '/criteria/2/evidence/0: missing "instructions"', "manual evidence needs instructions");
  bad((c) => (c.criteria[1].id = "AC-1"), '/criteria/1/id: duplicate criterion ID "AC-1"', "criterion IDs are unique");
  bad((c) => (c.criteria[1].evidence[0].id = "AC-1.e1"), '/criteria/1/evidence/0/id: duplicate evidence ID "AC-1.e1"', "evidence IDs are unique across the contract");
  bad((c) => (c.criteria[2].evidence[1].expect.stdout_matches = "(unclosed"), "stdout_matches: not a valid regular expression", "regular expressions must compile");
  bad((c) => (c.criteria[0].id = "AC 1"), "/criteria/0/id", "IDs have no spaces");

  throws(() => parseContract("{nope", "c.json"), /bad_contract.*not valid JSON/s, "parseContract rejects invalid JSON");
  throws(() => parseContract("{}", "c.json"), /bad_contract[\s\S]*missing "version"[\s\S]*missing "criteria"/, "parseContract lists every problem");
  assert(parseContract(JSON.stringify(CONTRACT)).criteria.length === 3, "parseContract returns a valid contract");
}

function reports() {
  console.log("\nReport schema\n");

  const report = {
    version: 1,
    run_id: "esc#42-r1",
    attempt: 2,
    status: "complete",
    outcome: "fail",
    validation_scope: "branch",
    head_sha: SHA,
    merge_base_sha: SHA,
    target_ref: "develop",
    target_sha: SHA,
    contract_digest: DIGEST,
    policy_version: `factory@3.8.0+settings:${DIGEST}`,
    lockfile_digest: DIGEST,
    tree_clean_after: true,
    tier: { proposed: "standard", actual: "standard", reasons: [] },
    changes: { new_evidence: 1, modified_assertions: 0, execution_policy: 0 },
    phases: [
      { name: "static", outcome: "pass", duration_s: 41, log: "logs/static.log" },
      { name: "evidence", outcome: "fail", duration_s: 132, log: "logs/verify.log" },
    ],
    evidence: [{ id: "AC-1.e1", executed: "failed", supports_criterion: null, excerpt: "expected 401, received 500" }],
    findings: [
      { id: "evidence:AC-1.e1", severity: "blocking", detail: "rejects expired token fails: expected 401, got 500", evidence_digest: DIGEST },
    ],
    flags: [],
    budget: { attempts_used: 2, wall_clock_s: 1840, tokens: 412000 },
  };
  assert(schemaErrors("report", report).length === 0, "the §5.3 example validates");
  const draft = { ...clone(report), status: "awaiting_review", outcome: null, lockfile_digest: null };
  assert(schemaErrors("report", draft).length === 0, "a draft has a null outcome; a project may have no lockfile");
  for (const outcome of ["pass", "fail", "blocked", "error", "pending_manual", "interrupted"]) {
    assert(schemaErrors("report", { ...report, outcome }).length === 0, `outcome ${outcome} (§5.4)`);
  }
  assert(schemaErrors("report", { ...report, outcome: "maybe" })[0].startsWith("/outcome: must be one of"), "unknown outcomes are rejected");
  assert(schemaErrors("report", { ...report, head_sha: "HEAD" })[0].startsWith("/head_sha"), "SHAs are full hex object names");
  const judged = (evidence_type: string) => ({
    ...report,
    findings: [{ id: "judgment:AC-3.e1", severity: "blocking", detail: "reviewer: manual procedure is not adequate: x", evidence_type }],
  });
  assert(
    ["test", "command", "manual"].every((t) => schemaErrors("report", judged(t)).length === 0) &&
      schemaErrors("report", judged("doc"))[0]?.startsWith("/findings/0/evidence_type"),
    "a report finding may carry evidence_type, and an unknown evidence_type is rejected",
  );
}

function verdicts() {
  console.log("\nVerdict schema\n");

  const verdict = {
    version: 1,
    source_digest: DIGEST,
    evidence: [
      { id: "AC-1.e1", supports_criterion: "yes", rationale: "covers the expiry path" },
      { id: "AC-3.e1", procedure_adequate: "yes", rationale: "the section is checkable" },
    ],
    sensitive_paths: [{ path: "src/auth/refresh.ts", signoff: "approve", rationale: "narrow change" }],
    modified_assertions: [{ location: "tests/auth/refresh.test.ts:88", justified: true, rationale: "status code was wrong" }],
    findings: [{ severity: "advisory", detail: "consider a constant", location: "src/auth/refresh.ts:12" }],
  };
  assert(schemaErrors("verdict", verdict).length === 0, "the §4.9 example validates");
  const both = clone(verdict);
  (both.evidence[0] as Record<string, unknown>).procedure_adequate = "yes";
  assert(
    schemaErrors("verdict", both).join() === '/evidence/0: needs exactly one of "supports_criterion" or "procedure_adequate"',
    "an evidence judgment has exactly one of the two judgments",
  );
  const neither = clone(verdict);
  delete (neither.evidence[0] as Record<string, unknown>).supports_criterion;
  assert(schemaErrors("verdict", neither).length === 1, "a judgment can't be missing");
  assert(schemaErrors("verdict", { ...verdict, source_digest: "abc" })[0].startsWith("/source_digest"), "source_digest is a sha256 digest");
  assert(schemaErrors("verdict", { ...verdict, findings: [{ severity: "major", detail: "x" }] })[0].includes("blocking"), "severity is blocking or advisory");
}

function readiness() {
  console.log("\nReadiness schema\n");

  assert(schemaErrors("readiness", { version: 1, status: "ready", questions: [] }).length === 0, "ready with no questions");
  const needs = { version: 1, status: "needs_human", questions: [{ about: "criterion", ref: "AC-2", question: "What counts as 'fast'?" }] };
  assert(schemaErrors("readiness", needs).length === 0, "needs_human with a question");
  assert(schemaErrors("readiness", { ...needs, questions: [] }).length > 0, "needs_human must ask something");
  assert(schemaErrors("readiness", { ...needs, status: "ready" }).length > 0, "ready can't have open questions");
}

contracts();
reports();
verdicts();
readiness();
console.log("\nAll factory schema tests passed.");
