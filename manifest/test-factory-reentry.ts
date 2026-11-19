import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun, revokeRun } from "./factory/runs.ts";
import { getRun, transitionRun, transitionAttempt, recordEvent, type RunRow } from "./factory/state.ts";
import { allocateAttempt } from "./factory/attempts.ts";
import { continueRun } from "./factory/fixloop.ts";
import { reentries, reentrySummary, REENTRY_TRIGGERS } from "./factory/reentry.ts";
import { currentOwner } from "./factory/owner.ts";
import { assert, throws, tempDir, cleanup, makeRepo, memDb, contractJson, contractFor } from "./factory/testkit.ts";

/**
 * Re-entry after the PR is open (#97): `factory continue` takes a run with
 * a PR back to implementing, under the same contract and authorization,
 * with a new deadline, and records why.
 */

const HOUR = 3_600_000;
const owner = currentOwner("test reentry");

async function run() {
  const db = await memDb();
  const ctxDir = tempDir();
  const root = realpathSync(
    makeRepo({ branch: "97-x", origin: "git@github.com:acme/w.git", claudeMd: `## Escapement Settings\n\n- **context-path**: ${ctxDir}\n` }),
  );
  const ctx = projectContext(root);
  let n = 0;

  /**
   * An approved run (budget `budgetMs`) whose attempts completed with
   * `outcomes`; the last one opened PR 41 when `pr` is set. Ends in pr_open,
   * or escalated when `escalate` is set (as record-manual or the fix loop
   * leaves it).
   */
  const withPr = (
    outcomes: string[],
    o: { escalate?: string; maxAttempts?: number; budgetMs?: number; worktree?: string; gate?: string[] } = {},
  ): RunRow => {
    const r = startRun(db, {
      workItem: `acme/w#${++n}`,
      ctx: o.worktree ? ctx : { ...ctx, worktreePath: `/reentry${n}` },
      artifactDir: tempDir(),
    });
    approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: o.budgetMs ?? HOUR, maxAttempts: o.maxAttempts ?? 3 });
    transitionRun(db, r.run_id, "implementing");
    for (const outcome of outcomes) {
      if (getRun(db, r.run_id).state === "implementing") transitionRun(db, r.run_id, "validating");
      const a = allocateAttempt(db, r.run_id, { owner, headSha: `head${n}${outcome}`, contractDigest: getRun(db, r.run_id).contract_digest!, policyVersion: "p" });
      transitionAttempt(db, r.run_id, a.attempt, "complete", { outcome });
      if (outcome === "fail" || outcome === "error") transitionRun(db, r.run_id, "implementing");
    }
    transitionRun(db, r.run_id, "validated");
    db.prepare("UPDATE factory_runs SET pr_number = 41, gate_recommendation = ?, gate_reasons_json = ? WHERE run_id = ?").run(
      o.gate ? "ping" : "auto_merge",
      JSON.stringify(o.gate ?? []),
      r.run_id,
    );
    transitionRun(db, r.run_id, "pr_open", { reason: "PR #41" });
    if (o.escalate) transitionRun(db, r.run_id, "escalated", { reason: o.escalate });
    return getRun(db, r.run_id);
  };
  /** Record a human's failed manual check of `attempt`, as record-manual does, and fail that attempt. */
  const failManual = (r: RunRow, attempt: number) => {
    const a = db.prepare("SELECT head_sha FROM factory_attempts WHERE run_id = ? AND attempt = ?").get(r.run_id, attempt) as { head_sha: string };
    recordEvent(db, r.run_id, "manual_outcome", { attempt, evidence_id: "AC-2.e1", outcome: "fail", note: "button missing", recorder: "marc", head_sha: a.head_sha });
    db.prepare("UPDATE factory_attempts SET outcome = 'fail' WHERE run_id = ? AND attempt = ?").run(r.run_id, attempt);
    transitionRun(db, r.run_id, "escalated", { reason: "manual:AC-2.e1" });
    return getRun(db, r.run_id);
  };

  console.log("continue from pr_open\n");
  {
    const r = withPr(["pass"], { gate: ["outcome: pending_manual"] });
    const c = continueRun(db, r.run_id, { reason: "the README example is wrong", owner });
    const after = getRun(db, r.run_id);
    const ev = reentries(db, r.run_id);
    assert(
      c.changed && after.state === "implementing" && after.contract_digest === r.contract_digest &&
        c.reentry?.trigger === "operator_request" && ev.length === 1 && ev[0].trigger === "operator_request",
      "continue takes a pr_open run back to implementing and records operator_request by default",
    );

    const f = withPr(["pending_manual"]);
    const cf = continueRun(db, f.run_id, { reason: "review: rename the flag", trigger: "review_finding", owner });
    assert(cf.changed && cf.reentry?.trigger === "review_finding" && reentries(db, f.run_id)[0].trigger === "review_finding", "--trigger review_finding is recorded on a pr_open re-entry");

    const bad = withPr(["pass"]);
    throws(() => continueRun(db, bad.run_id, { reason: "x", trigger: "because" }), /usage/, "an unknown --trigger value is a usage error");
    assert(getRun(db, bad.run_id).state === "pr_open" && reentries(db, bad.run_id).length === 0, "and the run is left as it was");

    const esc = withPr(["pass"]);
    failManual(esc, 1);
    let usage = "";
    try {
      continueRun(db, esc.run_id, { reason: "x", trigger: "review_finding" });
    } catch (err) {
      usage = `${(err as { code?: string }).code}`;
    }
    continueRun(db, esc.run_id, { reason: "fix the button", owner });
    const retry = continueRun(db, esc.run_id, { reason: "fix the button", trigger: "review_finding", owner });
    assert(
      usage === "usage" && !retry.changed && retry.reentry?.trigger === "manual_check_failed",
      "--trigger on an escalated run is a usage error, and repeating continue with it after the run is back in implementing is not",
    );
    const tr = withPr(["pass"]);
    continueRun(db, tr.run_id, { reason: "x", trigger: "review_finding", owner });
    const tr2 = continueRun(db, tr.run_id, { reason: "x", trigger: "review_finding", owner });
    assert(!tr2.changed && reentries(db, tr.run_id).length === 1, "continuing again after the run is back in implementing changes nothing and adds no event");
  }

  console.log("\ncontinue from escalated, with a PR\n");
  {
    const m = failManual(withPr(["pending_manual"]), 1);
    const c = continueRun(db, m.run_id, { reason: "the button is back", owner });
    assert(
      c.changed && getRun(db, m.run_id).state === "implementing" && c.reentry?.trigger === "manual_check_failed" && c.reentry.from_state === "escalated",
      "a run escalated by a failed manual check continues with trigger manual_check_failed",
    );

    const a = withPr(["pass"]);
    continueRun(db, a.run_id, { reason: "operator: tighten the docs", owner });
    transitionRun(db, a.run_id, "validating");
    const second = allocateAttempt(db, a.run_id, { owner, headSha: "later", contractDigest: a.contract_digest!, policyVersion: "p" });
    transitionAttempt(db, a.run_id, second.attempt, "complete", { outcome: "fail" });
    transitionRun(db, a.run_id, "escalated", { reason: "stuck" });
    const ca = continueRun(db, a.run_id, { reason: "try once more", owner });
    assert(
      ca.changed && ca.reentry?.trigger === "attempt_failed" && ca.reentry.attempt === 2 && reentries(db, a.run_id).length === 2,
      "an escalated run with a PR and a failed attempt continues with trigger attempt_failed",
    );
    assert(REENTRY_TRIGGERS.join() === "review_finding,operator_request,manual_check_failed,attempt_failed", "there are four triggers, two given and two derived");
  }

  console.log("\nrefusals\n");
  {
    const spent = withPr(["fail", "fail", "pass"], { maxAttempts: 3 });
    throws(() => continueRun(db, spent.run_id, { reason: "x" }), /attempt_budget/, "a run with every attempt used is refused");
    assert(
      getRun(db, spent.run_id).state === "pr_open" && getRun(db, spent.run_id).max_attempts === 3,
      "a pr_open run with every attempt used can't re-enter (attempt_budget), and the budget is not raised",
    );

    const codes: string[] = [];
    const code = (fn: () => unknown) => {
      try {
        fn();
        codes.push("ok");
      } catch (err) {
        codes.push(`${(err as { code?: string }).code}`);
      }
    };
    const revoked = withPr(["pass"]);
    revokeRun(db, revoked.run_id);
    code(() => continueRun(db, revoked.run_id, { reason: "x" }));
    const changed = withPr(["pass"]);
    writeFileSync(join(changed.artifact_dir, "contract.json"), contractJson(changed.run_id, { risk_tier_proposed: "sensitive" }));
    code(() => continueRun(db, changed.run_id, { reason: "x" }));
    const closed = withPr(["pass"]);
    transitionRun(db, closed.run_id, "closed", { action: "merged" });
    code(() => continueRun(db, closed.run_id, { reason: "x" }));
    const blockedRun = withPr(["pass"]);
    transitionRun(db, blockedRun.run_id, "blocked", { reason: "x" });
    code(() => continueRun(db, blockedRun.run_id, { reason: "x" }));
    const validated = withPr(["pass"]);
    db.prepare("UPDATE factory_runs SET state = 'validated' WHERE run_id = ?").run(validated.run_id);
    code(() => continueRun(db, validated.run_id, { reason: "x" }));
    assert(
      codes.join() === "not_authorized,contract_mismatch,run_closed,wrong_state,wrong_state",
      "re-entry is refused without an active authorization, with a changed contract, when closed, when blocked, and when validated",
    );

    const passedEsc = withPr(["pass"], { escalate: "run_deadline" });
    throws(
      () => continueRun(db, passedEsc.run_id, { reason: "x" }),
      /no_failed_attempt/,
      "an escalated run with a PR whose latest attempt passed is refused with no_failed_attempt",
    );
  }

  console.log("\nthe new deadline\n");
  {
    const r = withPr(["pass"], { budgetMs: 4 * HOUR });
    const later = Date.parse(r.deadline_at!) + 10 * HOUR;
    const c = continueRun(db, r.run_id, { reason: "review came in late", owner, now: later, budgetMs: 2 * HOUR });
    assert(
      c.changed && getRun(db, r.run_id).deadline_at === new Date(later + 2 * HOUR).toISOString(),
      "re-entering past the old deadline with --run-budget sets a new deadline of now plus that budget",
    );
    const ev = reentries(db, r.run_id)[0];
    assert(
      ev.previous_deadline === r.deadline_at && ev.deadline === new Date(later + 2 * HOUR).toISOString() &&
        ev.reason === "review came in late" && ev.run_budget_ms === 2 * HOUR,
      "the re-entry event records the previous and new deadline and the reason",
    );

    // A real worktree: its CLAUDE.md's run-budget changes after approval.
    const w = withPr(["pass"], { budgetMs: 3 * HOUR, worktree: root });
    writeFileSync(join(root, "CLAUDE.md"), `## Escapement Settings\n\n- **context-path**: ${ctxDir}\n- **run-budget**: 40h\n`);
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "loosen run-budget"], { cwd: root });
    const wl = Date.parse(w.deadline_at!) + HOUR;
    continueRun(db, w.run_id, { reason: "late review", owner, now: wl });
    const got = Date.parse(getRun(db, w.run_id).deadline_at!) - wl;
    assert(
      Math.abs(got - 3 * HOUR) <= 2000,
      "without --run-budget the new deadline uses the budget fixed at approval, and a later commit to the branch's run-budget setting doesn't change it",
    );

    // Second re-entry: the approved budget again, not what was left of the first.
    transitionRun(db, w.run_id, "validating");
    const a2 = allocateAttempt(db, w.run_id, { owner, headSha: "w2", contractDigest: w.contract_digest!, policyVersion: "p" });
    transitionAttempt(db, w.run_id, a2.attempt, "complete", { outcome: "pass" });
    transitionRun(db, w.run_id, "validated");
    transitionRun(db, w.run_id, "pr_open");
    const w2 = wl + 2.5 * HOUR;
    continueRun(db, w.run_id, { reason: "second look", owner, now: w2 });
    const got2 = Date.parse(getRun(db, w.run_id).deadline_at!) - w2;
    assert(Math.abs(got2 - 3 * HOUR) <= 2000, "a second re-entry reuses the approved budget, not the first re-entry's remaining time");

    const noDeadline = withPr(["pass"]);
    db.prepare("UPDATE factory_runs SET deadline_at = NULL WHERE run_id = ?").run(noDeadline.run_id);
    continueRun(db, noDeadline.run_id, { reason: "x", owner });
    assert(getRun(db, noDeadline.run_id).deadline_at === null, "a run with no deadline keeps none");
  }

  console.log("\nthe re-entry event\n");
  {
    const r = withPr(["pass"], { gate: ["attempts: 2 of at most 1"] });
    continueRun(db, r.run_id, { reason: "x", trigger: "review_finding", owner });
    const ev = reentries(db, r.run_id)[0];
    const att = db.prepare("SELECT head_sha FROM factory_attempts WHERE run_id = ? AND attempt = 1").get(r.run_id) as { head_sha: string };
    assert(
      ev.trigger === "review_finding" && ev.attempt === 1 && ev.head_sha === att.head_sha && ev.outcome === "pass" &&
        ev.gate_recommendation === "ping" && ev.gate_reasons[0] === "attempts: 2 of at most 1" && ev.pr_number === 41 && ev.from_state === "pr_open",
      "the re-entry event carries trigger, attempt, head, gate recommendation and PR number",
    );
    const s = reentrySummary(db, r.run_id);
    assert(s?.count === 1 && s.trigger === "review_finding" && s.attempt === 1 && s.reason === "x", "the summary names the count, trigger, attempt and reason");
    const plain = db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE run_id = ? AND json_extract(detail_json, '$.entity') = 'reentry'").get(withPr(["pass"]).run_id) as { n: number };
    assert(plain.n === 0, "a run never re-entered has no re-entry event");
  }

  db.close();
  console.log("\nAll factory re-entry tests passed.");
}

try {
  await run();
} finally {
  cleanup();
}
