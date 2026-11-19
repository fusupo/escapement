import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateGate, gatherFacts, recordGate, latestGate, gateLimits, type GateFacts, type GateLimits, type GateReport } from "./factory/gate.ts";
import { getRun } from "./factory/state.ts";
import { recordReentry } from "./factory/reentry.ts";
import { parseFactorySettings } from "./factory/settings.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, makeRepo, memDb, seedRun, sh, cleanup } from "./factory/testkit.ts";

/**
 * The gate in report-only mode (§6.3, #110): every rule holding gives
 * auto_merge; each failed rule gives ping with its own reason.
 */

const LIMITS: GateLimits = { maxDiffLines: 400, maxDiffFiles: 15, maxAdvisories: 0, maxAttempts: 1 };

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    tier: { actual: "standard", reasons: [] },
    outcome: "pass",
    pendingManual: [],
    modifiedAssertions: { count: 0, findings: [] },
    executionPolicy: { count: 0, findings: [] },
    head: { ok: true, detail: "" },
    contractDigest: { report: "sha256:aa", authorized: "sha256:aa" },
    advisories: [],
    diff: { files: 3, lines: 120 },
    attempts: 1,
    ...over,
  };
}

type Db = Awaited<ReturnType<typeof memDb>>;

/** A run on a real repo with one committed change (3 lines, 1 file) and a report for it. */
async function fixture(): Promise<{ db: Db; root: string; base: string; head: string; report: GateReport }> {
  const db = await memDb();
  const root = makeRepo();
  const base = sh("git", ["rev-parse", "HEAD"], root);
  writeFileSync(join(root, "a.ts"), "1\n2\n3\n");
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", "work"], root);
  const head = sh("git", ["rev-parse", "HEAD"], root);
  seedRun(db, "r1", { worktree_path: root });
  const report: GateReport = {
    outcome: "pending_manual",
    head_sha: head,
    merge_base_sha: base,
    target_sha: base,
    contract_digest: "sha256:aa",
    tier: { proposed: "standard", actual: "standard", reasons: [] },
    changes: { new_evidence: 1, modified_assertions: 1, execution_policy: 1 },
    evidence: [
      { id: "AC-1.e1", executed: "passed", supports_criterion: "yes" },
      { id: "AC-2.e1", executed: "pending_manual", supports_criterion: null },
    ],
    findings: [
      // validate.ts reports modified assertions and policy changes as advisory findings too.
      { id: "assertion:t.test.ts:3", severity: "advisory", detail: "modified assertion" },
      { id: "policy:jest.config.js", severity: "advisory", detail: "execution policy change" },
      { id: "review:1", severity: "advisory", detail: "a nit" },
    ],
  };
  return { db, root, base, head, report };
}

const failed = (f: GateFacts, limits = LIMITS) => evaluateGate(f, limits).checks.filter((c) => !c.ok).map((c) => c.rule);
/** ping with exactly one reason, from `rule`, containing `text`. */
function pingsFor(f: GateFacts, rule: string, text: string): boolean {
  const r = evaluateGate(f, LIMITS);
  return r.recommendation === "ping" && r.reasons.length === 1 && failed(f).join() === rule && r.reasons[0].includes(text);
}

async function run() {
  console.log("Rules\n");

  {
    const r = evaluateGate(facts(), LIMITS);
    assert(
      r.mode === "report-only" && r.recommendation === "auto_merge" && r.reasons.length === 0 && r.checks.length === 10 && r.checks.every((c) => c.ok),
      "every rule holding recommends auto_merge with no reasons",
    );
    const atLimits = evaluateGate(facts({ diff: { files: 15, lines: 400 }, attempts: 1, advisories: [] }), LIMITS);
    assert(atLimits.recommendation === "auto_merge", "values at their limits still hold");
  }

  assert(
    pingsFor(facts({ tier: { actual: "sensitive", reasons: ["sensitive path: src/auth/a.ts (matches src/auth/**)"] } }), "tier", "src/auth/a.ts"),
    "a sensitive actual tier gives ping with the tier reasons",
  );

  assert(
    pingsFor(facts({ outcome: "pending_manual", pendingManual: ["AC-2.e1"] }), "outcome", "AC-2.e1") &&
      pingsFor(facts({ outcome: "fail" }), "outcome", "fail") &&
      pingsFor(facts({ outcome: "error" }), "outcome", "error"),
    "an outcome other than pass gives ping",
  );

  assert(
    pingsFor(facts({ modifiedAssertions: { count: 1, findings: [] } }), "modified_assertions", "modified assertions: 1") &&
      pingsFor(facts({ modifiedAssertions: { count: 0, findings: ["test/a.test.ts:12"] } }), "modified_assertions", "test/a.test.ts:12"),
    "a modified assertion (changes count or assertion finding) gives ping",
  );

  assert(
    pingsFor(facts({ executionPolicy: { count: 2, findings: [] } }), "execution_policy", "execution policy changes: 2") &&
      pingsFor(facts({ executionPolicy: { count: 0, findings: ["jest.config.js"] } }), "execution_policy", "jest.config.js"),
    "an execution policy change (changes count or policy finding) gives ping",
  );

  assert(
    pingsFor(facts({ head: { ok: false, detail: "HEAD is bbb, attempt validated aaa" } }), "head", "HEAD is bbb"),
    "a report head that is not the branch head gives ping",
  );

  assert(
    pingsFor(facts({ contractDigest: { report: "sha256:old", authorized: "sha256:new" } }), "contract_digest", "sha256:old") &&
      pingsFor(facts({ contractDigest: { report: "sha256:aa", authorized: null } }), "contract_digest", "no active authorization"),
    "a report for another contract digest than the authorization gives ping",
  );

  {
    const raised = evaluateGate(facts({ advisories: ["review:1", "review:2"] }), { ...LIMITS, maxAdvisories: 2 });
    const { db, report } = await fixture();
    const real = evaluateGate(gatherFacts(db, getRun(db, "r1"), report, "sha256:aa"), { ...LIMITS, maxAdvisories: 1 });
    const reasons = real.reasons.join(" | ");
    assert(
      pingsFor(facts({ advisories: ["review:1"] }), "advisories", "over gate-max-advisories (0): review:1") &&
        raised.recommendation === "auto_merge" &&
        real.checks.find((c) => c.rule === "advisories")?.ok === true &&
        real.checks.find((c) => c.rule === "advisories")?.detail.startsWith("1 advisory finding") === true &&
        reasons.includes("modified assertions: 1 (t.test.ts:3)") &&
        reasons.includes("execution policy changes: 1 (jest.config.js)"),
      "advisory findings over gate-max-advisories give ping, and assertion and policy findings are not counted twice",
    );
    db.close();
  }

  {
    const lines = facts({ diff: { files: 3, lines: 401 } });
    const files = facts({ diff: { files: 16, lines: 10 } });
    const both = evaluateGate(facts({ diff: { files: 16, lines: 401 } }), LIMITS);
    assert(
      pingsFor(lines, "diff_lines", "over gate-max-diff-lines (400)") &&
        pingsFor(files, "diff_files", "over gate-max-diff-files (15)") &&
        both.reasons.length === 2 &&
        both.reasons[0].includes("401 lines") &&
        both.reasons[1].includes("16 files"),
      "a diff over gate-max-diff-lines or gate-max-diff-files gives ping, each with its own reason",
    );
  }

  assert(
    pingsFor(facts({ attempts: 2 }), "attempts", "used 2 attempts, over gate-max-attempts (1)") &&
      evaluateGate(facts({ attempts: 3 }), { ...LIMITS, maxAttempts: 3 }).recommendation === "auto_merge",
    "more attempts than gate-max-attempts gives ping, and as many as it allows does not",
  );

  {
    const back = facts({ reentries: [{ trigger: "review_finding", attempt: 1 }] });
    const r = evaluateGate(back, { ...LIMITS, maxAttempts: 9 });
    assert(
      r.recommendation === "ping" && r.reasons.length === 1 && r.checks.filter((c) => !c.ok).map((c) => c.rule).join() === "reentry" &&
        r.reasons[0].includes("re-entered after its PR opened") && r.reasons[0].includes("review_finding after attempt 1"),
      "a re-entered run gives ping with a reason naming the re-entry, even when every other rule holds",
    );
    const both = evaluateGate(facts({ attempts: 2, reentries: [{ trigger: "manual_check_failed", attempt: 1 }] }), LIMITS);
    assert(
      both.recommendation === "ping" && both.checks.filter((c) => !c.ok).map((c) => c.rule).join() === "attempts,reentry" &&
        both.reasons.some((x) => x.includes("over gate-max-attempts (1)")) && both.reasons.some((x) => x.includes("manual_check_failed")),
      "with gate-max-attempts 1 a re-entered run shows both the attempts reason and the re-entry reason",
    );
    const never = evaluateGate(facts({ reentries: [] }), LIMITS);
    assert(
      never.checks.length === 10 && !never.checks.some((c) => c.rule === "reentry") && r.checks.length === 11 && r.checks.some((c) => c.rule === "reentry"),
      "the reentry check is emitted only when the run was re-entered",
    );
  }

  {
    const manyFacts = facts({ tier: { actual: "sensitive", reasons: [] }, outcome: "pending_manual", advisories: ["review:1"], attempts: 2 });
    const many = evaluateGate(manyFacts, LIMITS);
    const unknown = facts({ diff: { unknown: "bad revision 'deadbeef'" } });
    assert(
      many.recommendation === "ping" &&
        many.reasons.length === 4 &&
        failed(manyFacts).join() === "tier,outcome,advisories,attempts" &&
        evaluateGate(unknown, LIMITS).recommendation === "ping" &&
        failed(unknown).join() === "diff_lines,diff_files" &&
        evaluateGate(unknown, LIMITS).reasons.every((r) => r.includes("diff size unknown")),
      "several failed rules give one reason each, and an unknown diff size fails the diff rule",
    );
  }

  {
    const s = parseFactorySettings(new Map([["gate-max-diff-lines", "50"]])).settings;
    const l = gateLimits(s);
    assert(l.maxDiffLines === 50 && l.maxDiffFiles === 15 && l.maxAdvisories === 0 && l.maxAttempts === 1, "the limits come from the settings");
  }

  console.log("\nFacts from a report\n");

  {
    const { db, head, report } = await fixture();
    const insertAttempt = db.prepare(
      "INSERT INTO factory_attempts (run_id, attempt, status, head_sha, contract_digest, policy_version, started_at) VALUES (?, ?, ?, ?, 'sha256:aa', 'p', 'now')",
    );
    insertAttempt.run("r1", 1, "interrupted", head);
    insertAttempt.run("r1", 2, "complete", head);
    const f = gatherFacts(db, getRun(db, "r1"), report, "sha256:aa");
    assert(
      f.advisories.join() === "review:1" &&
        f.modifiedAssertions.findings.join() === "t.test.ts:3" &&
        f.executionPolicy.findings.join() === "jest.config.js" &&
        f.modifiedAssertions.count === 1 &&
        f.executionPolicy.count === 1,
      "advisories leave out the assertion: and policy: findings, which are their own rules",
    );
    assert(f.diff && !("unknown" in f.diff) && f.diff.files === 1 && f.diff.lines === 3, "the diff is measured from the report's merge base to its head");
    assert(f.attempts === 2 && f.pendingManual.join() === "AC-2.e1" && f.head.ok, "attempts count interrupted ones; pending manual checks are named");
    {
      recordReentry(db, "r1", {
        trigger: "operator_request", reason: "x", pr_number: 7, from_state: "pr_open", attempt: 2, head_sha: head, outcome: "pass",
        gate_recommendation: "auto_merge", gate_reasons: [], previous_deadline: null, deadline: null, run_budget_ms: null,
      });
      const g = gatherFacts(db, getRun(db, "r1"), report, "sha256:aa");
      assert(
        f.reentries?.length === 0 && g.reentries?.length === 1 && g.reentries[0].trigger === "operator_request" && g.reentries[0].attempt === 2,
        "the gate reads a run's re-entries from its events",
      );
      db.prepare("DELETE FROM factory_events WHERE run_id = 'r1' AND json_extract(detail_json, '$.entity') = 'reentry'").run();
    }
    const noBase = gatherFacts(db, getRun(db, "r1"), { ...report, merge_base_sha: undefined }, "sha256:aa");
    const bad = gatherFacts(db, getRun(db, "r1"), { ...report, merge_base_sha: "0".repeat(40) }, "sha256:aa");
    assert(
      !("unknown" in noBase.diff) && noBase.diff.lines === 3 && "unknown" in bad.diff,
      "without a merge base the diff falls back to merge-base, and an unreadable one is unknown",
    );

    console.log("\nRecording\n");

    const result = evaluateGate(f, LIMITS);
    const ctx = { attempt: 2, report_revision: 1, head_sha: head, outcome: "pending_manual", limits: LIMITS, owner: currentOwner("pr") };
    const first = recordGate(db, "r1", result, ctx);
    const again = recordGate(db, "r1", result, ctx);
    const events = () => (db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE run_id = 'r1' AND kind = 'gate'").get() as { n: number }).n;
    const row = db.prepare("SELECT gate_recommendation, gate_reasons_json FROM factory_runs WHERE run_id = 'r1'").get() as {
      gate_recommendation: string;
      gate_reasons_json: string;
    };
    assert(
      first.changed && !again.changed && events() === 1 && row.gate_recommendation === "ping" && JSON.parse(row.gate_reasons_json).length === result.reasons.length,
      "recordGate stores the latest result on the run and adds one event per changed result",
    );
    const resolved = evaluateGate({ ...f, outcome: "pass", pendingManual: [], modifiedAssertions: { count: 0, findings: [] }, executionPolicy: { count: 0, findings: [] }, advisories: [], attempts: 1 }, LIMITS);
    const next = recordGate(db, "r1", resolved, { ...ctx, report_revision: 2, outcome: "pass" });
    const latest = latestGate(db, "r1");
    assert(
      next.changed && events() === 2 && latest?.recommendation === "auto_merge" && latest.report_revision === 2 && latest.checks.length === 10,
      "a new result adds an event and the latest event carries its checks and context",
    );
    db.close();
  }

  console.log("\nAll factory gate tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
