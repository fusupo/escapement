// The bounded fix loop (docs/FACTORY_DESIGN.md §6.2, #92): after an attempt
// that didn't pass, the run goes back to implementing while the implementer
// can fix it, and escalates when it needs a human.
import { readFileSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { validateRun } from "./factory/validate.ts";
import { reviewInput, recordReview, type Bundle } from "./factory/review.ts";
import { decideAfterAttempt } from "./factory/fixloop.ts";
import { getRun, getAttempt } from "./factory/state.ts";
import { assert, cleanup } from "./factory/testkit.ts";
import { owner, SETTINGS, HOUR, TEST_FILE, junit, PASSING, commit, project } from "./factory/fixtures.ts";

const validate = (db: Database, runId: string, timeoutMs?: number) =>
  validateRun(db, runId, { owner, lockWaitMs: 5_000, graceMs: 200, timeoutMs });

type Verdict = {
  version: 1;
  source_digest: string;
  evidence: Record<string, unknown>[];
  sensitive_paths: { path: string; signoff: string; rationale: string }[];
  modified_assertions: { location: string; justified: boolean; rationale: string }[];
  findings: { severity: string; detail: string; location?: string }[];
};

/** Issue the review for `attempt` and record an approving verdict, after `tweak`. */
async function review(db: Database, runId: string, attempt: number, tweak: (v: Verdict) => void = () => {}) {
  const b = JSON.parse(readFileSync((await reviewInput(db, runId, attempt, { owner, lockWaitMs: 5_000 })).bundle_path, "utf-8")) as Bundle;
  const v: Verdict = {
    version: 1,
    source_digest: b.source.digest,
    evidence: b.required.evidence.map((e) => ({ id: e.id, [e.judgment]: "yes", rationale: "the test exercises the criterion" })),
    sensitive_paths: b.required.sensitive_paths.map((x) => ({ path: x.path, signoff: "approve", rationale: "scoped" })),
    modified_assertions: b.required.modified_assertions.map((m) => ({ location: m.location, justified: true, rationale: "the spec changed" })),
    findings: [],
  };
  tweak(v);
  return recordReview(db, runId, attempt, JSON.stringify(v), { owner, lockWaitMs: 5_000 });
}

const FAILING = { "ci/junit.xml": junit([{ name: "auth rejects expired", status: "failed" }]), "ci/verify-exit": "1\n" };
const FIXED = { "ci/junit.xml": PASSING, "ci/verify-exit": "0\n" };
/** static prints ci/msg, so the failure's digest follows the message. */
const STATIC_MSG = { "ci/static.sh": 'cat ci/msg\nexit "$(cat ci/static-exit)"\n', "ci/msg": "error: A\n", "ci/static-exit": "2\n" };

async function run() {
  console.log("Back to implementation\n");
  {
    const { db, root, run } = await project({ branch: FAILING });
    const deadline = run.deadline_at;
    const r1 = await validate(db, run.run_id);
    assert(r1.outcome === "fail" && r1.run_state === "implementing" && /fix_loop/.test(r1.run_reason ?? ""), "attempt 1 fails and the run goes back to implementing");
    commit(root, FIXED, "fix");
    const r2 = await validate(db, run.run_id);
    assert(r2.attempt === 2 && r2.status === "awaiting_review", "attempt 2 is a new attempt");
    const rec = await review(db, run.run_id, 2);
    const after = getRun(db, run.run_id);
    assert(
      rec.outcome === "pass" && after.state === "validated" && after.deadline_at === deadline,
      "a fail goes back to implementing and passes on attempt 2",
    );
  }
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "sleep 5\n" } });
    const r = await validate(db, run.run_id, 300);
    assert(r.outcome === "error" && r.error?.cause === "code" && r.run_state === "implementing", "a code-caused error goes back to implementing");
  }
  {
    const { db, run } = await project({ branch: { "ci/static.sh": "git commit -q --allow-empty -m sneaky\n" } });
    const r = await validate(db, run.run_id);
    assert(r.outcome === "error" && r.error?.cause === "run" && r.run_state === "implementing", "a run-caused error goes back to implementing");
  }

  console.log("\nEscalations\n");
  {
    const { db, run } = await project({
      evidence: [{ id: "AC-1.e1", type: "command", kind: "new_behavior", run: "true", cwd: "no-such-dir", expect: { exit_code: 0 } }],
    });
    const r = await validate(db, run.run_id);
    assert(
      r.outcome === "error" && r.error?.cause === "environment" && r.run_state === "escalated" && /needs the operator/.test(r.run_reason ?? ""),
      "an environment error escalates at once",
    );
  }
  {
    const { db, root, run } = await project({ settings: SETTINGS + "- **max-attempts**: 2\n", branch: FAILING });
    assert((await validate(db, run.run_id)).run_state === "implementing", "attempt 1 of 2 loops");
    commit(root, { "src/app.ts": "export const app = 3;\n" });
    const r = await validate(db, run.run_id);
    assert(r.run_state === "escalated" && /attempt_budget: 2 of 2/.test(r.run_reason ?? ""), "exhausting max-attempts escalates");
  }
  {
    const { db, run } = await project({ branch: FAILING });
    await validate(db, run.run_id);
    const late = decideAfterAttempt(db, run.run_id, 1, { now: Date.now() + 3 * HOUR });
    assert(late.to === "escalated" && /run_deadline/.test(late.reason), "a passed deadline escalates instead of looping");
  }
  {
    const { db, run } = await project({ branch: { "src/auth/token.ts": "export const t = 1;\n" } });
    await validate(db, run.run_id);
    const rec = await review(db, run.run_id, 1, (v) => {
      v.sensitive_paths = v.sensitive_paths.map((x) => ({ ...x, signoff: "concern", rationale: "leaks the token" }));
    });
    assert(
      rec.outcome === "fail" && rec.run_state === "escalated" && /needs_operator: signoff:src\/auth\/token\.ts/.test(rec.run_reason ?? ""),
      "a refused sign-off escalates instead of looping",
    );
  }
  {
    const { db, run } = await project({ branch: { "tests/auth.test.ts": TEST_FILE.replace("toBe(200)", "toBe(201)") } });
    await validate(db, run.run_id);
    const rec = await review(db, run.run_id, 1, (v) => {
      v.modified_assertions = v.modified_assertions.map((m) => ({ ...m, justified: false, rationale: "weakens the check" }));
    });
    assert(
      rec.outcome === "fail" && rec.run_state === "escalated" && /needs_operator: justification:tests\/auth\.test\.ts/.test(rec.run_reason ?? ""),
      "an unjustified assertion change escalates instead of looping",
    );
  }

  console.log("\nStuck detection (§6.2)\n");
  {
    const { db, root, run } = await project({ branch: STATIC_MSG });
    assert((await validate(db, run.run_id)).run_state === "implementing", "attempt 1 fails static and loops");
    commit(root, { "src/app.ts": "export const app = 3;\n" });
    const r = await validate(db, run.run_id);
    assert(r.run_state === "escalated" && /stuck: check:static unchanged since attempt 1/.test(r.run_reason ?? ""), "an unchanged check failure across two attempts escalates as stuck");
  }
  {
    const { db, root, run } = await project({ branch: STATIC_MSG });
    await validate(db, run.run_id);
    commit(root, { "ci/msg": "error: B\n" });
    const r = await validate(db, run.run_id);
    assert(r.outcome === "fail" && r.run_state === "implementing", "a changed check failure is progress, not stuck");
  }
  {
    const { db, root, run } = await project({});
    const blocking = (v: Verdict) => {
      v.findings = [{ severity: "blocking", detail: "the diagram shows an edge the code never takes", location: "README.md" }];
    };
    await validate(db, run.run_id);
    assert((await review(db, run.run_id, 1, blocking)).run_state === "implementing", "a reviewer's blocking finding loops");
    commit(root, { "src/app.ts": "export const app = 3;\n" });
    await validate(db, run.run_id);
    const rec = await review(db, run.run_id, 2, blocking);
    assert(rec.outcome === "fail" && rec.run_state === "implementing" && getAttempt(db, run.run_id, 2).outcome === "fail", "reviewer findings never count as stuck");
  }

  console.log("\nAll factory fix-loop tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
