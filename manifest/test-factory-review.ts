import { readFileSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { validateRun, type Report } from "./factory/validate.ts";
import { parseContract } from "./factory/schemas.ts";
import { requiredJudgments, exportSnapshot, snapshotDigest, reviewDir, reviewInput, recordReview, verdictDigest, type Bundle } from "./factory/review.ts";
import { getRun, getAttempt, transitionAttempt } from "./factory/state.ts";
import { schemaErrors } from "./factory/schemas.ts";
import { assert, sh, tempDir, cleanup } from "./factory/testkit.ts";
import { owner, SETTINGS, TEST_EV, TEST_FILE, project } from "./factory/fixtures.ts";

const validate = (db: Database, runId: string) => validateRun(db, runId, { owner, lockWaitMs: 5_000, graceMs: 200 });
const issue = (db: Database, runId: string, attempt = 1, issueFile?: string) =>
  reviewInput(db, runId, attempt, { owner, lockWaitMs: 5_000, issueFile });

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ""} ${String(err)}`;
    const shown = String(err).replace(/\s*\n\s*-?\s*/g, " ");
    assert(pattern.test(text), `${msg} (${shown.length > 160 ? `${shown.slice(0, 160)}…` : shown})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

const record = (db: Database, runId: string, verdict: unknown, attempt = 1) =>
  recordReview(db, runId, attempt, typeof verdict === "string" ? verdict : JSON.stringify(verdict), { owner, lockWaitMs: 5_000 });

type V = {
  version: 1;
  source_digest: string;
  evidence: Record<string, unknown>[];
  sensitive_paths: Record<string, unknown>[];
  modified_assertions: Record<string, unknown>[];
  findings: Record<string, unknown>[];
};

/** A complete, approving verdict for a bundle. */
function verdictFor(b: Bundle): V {
  return {
    version: 1,
    source_digest: b.source.digest,
    evidence: b.required.evidence.map((e) => ({ id: e.id, [e.judgment]: "yes", rationale: "the test exercises the criterion" })),
    sensitive_paths: b.required.sensitive_paths.map((x) => ({ path: x.path, signoff: "approve", rationale: "change is scoped" })),
    modified_assertions: b.required.modified_assertions.map((m) => ({ location: m.location, justified: true, rationale: "the spec changed" })),
    findings: [],
  };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8"));

const CMD_EV = { id: "AC-2.e1", type: "command", kind: "regression", run: "true", expect: { exit_code: 0 } };
const MANUAL_EV = { id: "AC-3.e1", type: "manual", kind: "new_behavior", instructions: "Read docs/auth.md" };
const CRITERIA = [
  { id: "AC-1", text: "Expired tokens are rejected", evidence: [TEST_EV] },
  { id: "AC-2", text: "The CLI still runs", evidence: [CMD_EV] },
  { id: "AC-3", text: "Docs describe it", evidence: [MANUAL_EV] },
];

/** A validated attempt awaiting review: a sensitive file, a policy change and a modified assertion in the branch. */
async function awaiting(criteria: typeof CRITERIA = CRITERIA) {
  const p = await project({
    branch: {
      "src/auth/refresh.ts": "export const refresh = 1;\n",
      "ci/static.sh": 'exit "$(cat ci/static-exit)"\n# tweak\n',
      "tests/auth.test.ts": TEST_FILE.replace("toBe(200)", "toBe(201)"),
    },
    contract: { criteria },
  });
  const r = await validate(p.db, p.run.run_id);
  assert(r.status === "awaiting_review", `the attempt awaits review (${r.outcome ?? "no outcome"})`);
  const draft = readJson<Report>(r.report_path);
  const contract = parseContract(readFileSync(join(p.run.artifact_dir, "contract.json"), "utf-8"));
  return { ...p, r, draft, contract };
}

async function judgments() {
  console.log("Required judgments\n");
  const { root, draft, contract } = await awaiting();
  const req = requiredJudgments({ worktree: root, contract, draft });

  assert(req.evidence.map((e) => `${e.id}:${e.judgment}`).join() === "AC-1.e1:supports_criterion,AC-2.e1:supports_criterion,AC-3.e1:procedure_adequate", "every evidence ID; test and command take supports_criterion, manual takes procedure_adequate");
  const e1 = req.evidence[0];
  assert(e1.criterion === "Expired tokens are rejected" && e1.executed === "passed" && e1.spec === TEST_EV.selector, "with its criterion, the runner's result and its selector");
  assert(req.evidence[2].executed === "pending_manual" && req.evidence[2].spec === "Read docs/auth.md", "manual evidence is pending, with its instructions");

  const paths = req.sensitive_paths.map((s) => s.path);
  assert(paths.join() === "ci/static.sh,src/auth/refresh.ts", `the changed sensitive path and the policy change need sign-off → ${paths.join(", ")}`);
  assert(req.sensitive_paths[1].reasons[0] === "sensitive path (matches src/auth/**)", "with the pattern it matched");
  assert(req.sensitive_paths[0].reasons[0].startsWith("execution policy change"), "and the policy finding's detail");
  assert(req.modified_assertions.length === 1 && req.modified_assertions[0].location === "tests/auth.test.ts:2", "every modified-assertion location");
}

async function sensitiveAtBase() {
  console.log("\nSensitive patterns at both revisions\n");
  // The branch drops src/auth/** from sensitive-paths; the base's pattern still applies.
  const p = await project({
    branch: { "src/auth/refresh.ts": "x\n", "CLAUDE.md": SETTINGS.replace("- **sensitive-paths**: src/auth/**\n", "") },
  });
  const r = await validate(p.db, p.run.run_id);
  const draft = readJson<Report>(r.report_path);
  const contract = parseContract(readFileSync(join(p.run.artifact_dir, "contract.json"), "utf-8"));
  const paths = requiredJudgments({ worktree: p.root, contract, draft }).sensitive_paths.map((s) => s.path);
  assert(paths.includes("src/auth/refresh.ts"), "a branch can't drop the pattern that would catch its own change");
  assert(paths.includes("CLAUDE.md"), "and the settings change itself needs a sign-off");
}

async function snapshot() {
  console.log("\nSource snapshot\n");
  const { root, run, draft } = await awaiting();
  const dir = join(reviewDir(run.artifact_dir, 1), "source");
  const d1 = exportSnapshot(root, draft.head_sha, dir);
  assert(/^sha256:[0-9a-f]{64}$/.test(d1), "the snapshot has a sha256 digest");
  assert(readFileSync(join(dir, "src", "auth", "refresh.ts"), "utf-8") === "export const refresh = 1;\n", "it holds head_sha's files");
  assert(!existsSync(join(dir, ".git")), "and no repository");
  assert((statSync(join(dir, "src", "app.ts")).mode & 0o222) === 0, "its files are read-only");
  assert(snapshotDigest(dir) === d1, "the digest can be recomputed");

  // Live worktree changes don't reach the snapshot.
  writeFileSync(join(root, "src", "app.ts"), "export const app = 99;\n");
  assert(exportSnapshot(root, draft.head_sha, dir) === d1, "re-exporting the same revision gives the same digest, whatever the live tree holds");
  sh("git", ["checkout", "-q", "--", "src/app.ts"], root);

  chmodSync(join(dir, "src", "app.ts"), 0o644);
  writeFileSync(join(dir, "src", "app.ts"), "tampered\n");
  assert(snapshotDigest(dir) !== d1, "a changed file changes the digest");
  assert(exportSnapshot(root, draft.merge_base_sha, dir) !== d1, "another revision has another digest");
}

async function bundle() {
  console.log("\nreview-input\n");
  {
    const { db, run, draft } = await awaiting();
    const issueFile = join(tempDir(), "issue.md");
    writeFileSync(issueFile, "# Reject expired tokens\n");
    const r = await issue(db, run.run_id, 1, issueFile);
    const b = readJson<Bundle>(r.bundle_path);
    assert(r.bundle_path === join(reviewDir(run.artifact_dir, 1), "bundle.json"), "the bundle is written to attempts/{n}/review/bundle.json");
    assert(b.head_sha === draft.head_sha && b.merge_base_sha === draft.merge_base_sha, "bound to the attempt's revisions");
    assert(readFileSync(b.issue!.path, "utf-8") === "# Reject expired tokens\n", "with the issue text the host passed");
    assert(b.contract.content.criteria.length === 3 && b.contract.digest === getAttempt(db, run.run_id, 1).contract_digest, "the approved contract");
    const diff = readFileSync(b.diff, "utf-8");
    assert(diff.includes("+export const refresh = 1;") && diff.includes("src/app.ts"), "the exact merge_base..head diff");
    assert(b.source.digest === r.source_digest && snapshotDigest(b.source.path) === r.source_digest, "the snapshot and its digest");
    assert(b.report.path.endsWith("report.json") && b.report.tier.actual === "sensitive", "the draft report, tier and flags");
    assert(b.logs.length > 0 && b.logs.every((l) => existsSync(l)) && b.results.length === 1 && existsSync(b.results[0]), "paths to every log and results file");
    assert(b.required.evidence.length === 3 && b.required.sensitive_paths.length === 2 && b.required.modified_assertions.length === 1, "the required judgments");
    assert(b.verdict.schema.endsWith("schemas/factory/verdict.schema.json") && b.verdict.record.startsWith(`factory record-review ${run.run_id} 1 `), "where the verdict goes and how to record it");
    assert(b.reviewer_prompt.endsWith("prompts/factory/validation-reviewer.md"), "and the reviewer prompt");
    assert(!r.reused_snapshot && getAttempt(db, run.run_id, 1).status === "awaiting_review", "the attempt still awaits review");
    const ev = db.prepare("SELECT detail_json FROM factory_events WHERE json_extract(detail_json, '$.entity') = 'review'").all() as { detail_json: string }[];
    assert(ev.length === 1 && JSON.parse(ev[0].detail_json).source_digest === r.source_digest, "a review event records the issued digest");

    const again = await issue(db, run.run_id);
    assert(again.reused_snapshot && again.source_digest === r.source_digest, "re-issuing keeps an unchanged snapshot");
    assert(readJson<Bundle>(again.bundle_path).issue !== null, "and the issue text given earlier");
    chmodSync(join(b.source.path, "src", "app.ts"), 0o644);
    writeFileSync(join(b.source.path, "src", "app.ts"), "tampered\n");
    const fresh = await issue(db, run.run_id);
    assert(!fresh.reused_snapshot && fresh.source_digest === r.source_digest, "a changed snapshot is re-exported, with the same digest");
  }
  {
    const { db, run } = await awaiting();
    const b = readJson<Bundle>((await issue(db, run.run_id)).bundle_path);
    assert(b.issue === null, "without --issue-file the bundle says no issue text was given");
  }

  console.log("\nreview-input preconditions\n");
  {
    const { db, run } = await awaiting();
    await rejects(() => issue(db, run.run_id, 2), /no_such_attempt/, "an unknown attempt");
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), run.run_id);
    await rejects(() => issue(db, run.run_id), /run_deadline/, "past the run deadline it starts nothing (§4.1)");
  }
  {
    const { db, run } = await awaiting();
    writeFileSync(join(run.artifact_dir, "contract.json"), readFileSync(join(run.artifact_dir, "contract.json"), "utf-8") + " ");
    await rejects(() => issue(db, run.run_id), /contract_mismatch/, "a changed contract");
  }
  {
    const { db, root, run } = await awaiting();
    sh("git", ["commit", "-q", "--allow-empty", "-m", "later"], root);
    await rejects(() => issue(db, run.run_id), /revision_changed/, "a moved HEAD");
    assert(getAttempt(db, run.run_id, 1).outcome === "error" && getRun(db, run.run_id).state === "escalated", "completes the attempt as error and escalates the run");
    await rejects(() => issue(db, run.run_id), /run_halted|wrong_state/, "and it can't be reviewed afterwards");
  }
  {
    const p = await project({ branch: { "ci/static-exit": "1\n" } });
    await validate(p.db, p.run.run_id);
    await rejects(() => issue(p.db, p.run.run_id), /run_halted|wrong_state/, "an attempt that completed without review isn't reviewable");
  }
}

/** An attempt awaiting review with its bundle issued. */
async function issued(opts: { manual?: boolean } = {}) {
  const p = await awaiting(opts.manual === false ? CRITERIA.slice(0, 2) : CRITERIA);
  const b = readJson<Bundle>((await issue(p.db, p.run.run_id)).bundle_path);
  return { ...p, b };
}

function unchanged(db: Database, runId: string, reportBefore: string, reportPath: string, msg: string) {
  const a = getAttempt(db, runId, 1);
  assert(
    a.status === "awaiting_review" && a.verdict_digest === null && readFileSync(reportPath, "utf-8") === reportBefore && !existsSync(join(dirname(reportPath), "review.json")),
    `${msg}: the attempt stays awaiting_review and nothing is written`,
  );
}

async function completeness() {
  console.log("\nrecord-review: completeness\n");
  const { db, run, r, b } = await issued();
  const before = readFileSync(r.report_path, "utf-8");
  const full = verdictFor(b);

  const missingEvidence = { ...full, evidence: full.evidence.filter((e) => e.id !== "AC-2.e1") };
  await rejects(() => record(db, run.run_id, missingEvidence), /incomplete_verdict.*evidence AC-2\.e1: no judgment/s, "a verdict missing an evidence ID is rejected");
  unchanged(db, run.run_id, before, r.report_path, "missing evidence");

  const missingSignoff = { ...full, sensitive_paths: full.sensitive_paths.filter((x) => x.path !== "src/auth/refresh.ts") };
  await rejects(() => record(db, run.run_id, missingSignoff), /incomplete_verdict.*sensitive path src\/auth\/refresh\.ts: no sign-off/s, "a verdict missing a sensitive sign-off is rejected");
  const missingPolicy = { ...full, sensitive_paths: full.sensitive_paths.filter((x) => x.path !== "ci/static.sh") };
  await rejects(() => record(db, run.run_id, missingPolicy), /sensitive path ci\/static\.sh: no sign-off/, "so is one missing an execution-policy sign-off");

  const missingJustification = { ...full, modified_assertions: [] };
  await rejects(() => record(db, run.run_id, missingJustification), /modified assertion tests\/auth\.test\.ts:2: no justification/, "a verdict missing a justification is rejected");
  unchanged(db, run.run_id, before, r.report_path, "missing justification");

  const wrongDigest = { ...full, source_digest: `sha256:${"0".repeat(64)}` };
  await rejects(() => record(db, run.run_id, wrongDigest), /incomplete_verdict.*source_digest sha256:0+ is not the snapshot issued/s, "a verdict with the wrong source digest is rejected");
  unchanged(db, run.run_id, before, r.report_path, "wrong digest");

  const wrongKind = { ...full, evidence: full.evidence.map((e) => (e.id === "AC-3.e1" ? { id: e.id, supports_criterion: "yes", rationale: "x" } : e)) };
  await rejects(() => record(db, run.run_id, wrongKind), /evidence AC-3\.e1: judge procedure_adequate, not supports_criterion/, "manual evidence takes procedure_adequate");
  const twice = { ...full, evidence: [...full.evidence, full.evidence[0]] };
  await rejects(() => record(db, run.run_id, twice), /evidence AC-1\.e1: given 2 times/, "each evidence ID is judged exactly once");
  const unknown = { ...full, evidence: [...full.evidence, { id: "AC-9.e1", supports_criterion: "yes", rationale: "x" }], sensitive_paths: [...full.sensitive_paths, { path: "README.md", signoff: "approve", rationale: "x" }] };
  await rejects(() => record(db, run.run_id, unknown), /evidence AC-9\.e1: not one this attempt requires.*sensitive path README\.md: not one/s, "unknown entries are rejected, every problem listed");

  await rejects(() => record(db, run.run_id, "{ not json"), /invalid_verdict.*not JSON/s, "a verdict that isn't JSON is rejected");
  await rejects(() => record(db, run.run_id, { ...full, findings: [{ severity: "fatal", detail: "x" }] }), /invalid_verdict.*\/findings\/0\/severity/s, "a verdict that doesn't match verdict.schema.json is rejected");
  unchanged(db, run.run_id, before, r.report_path, "malformed");
  const rejections = db.prepare("SELECT COUNT(*) AS n FROM factory_events WHERE json_extract(detail_json, '$.entity') = 'verdict' AND json_extract(detail_json, '$.to') = 'rejected'").get() as { n: number };
  assert(rejections.n === 10, `each rejection is recorded as an event (${rejections.n})`);

  // Finally a complete verdict is accepted.
  const ok = await record(db, run.run_id, full);
  assert(ok.status === "complete" && ok.outcome === "pending_manual" && !ok.noop, "a complete verdict finalizes the attempt; manual evidence leaves it pending_manual");
  assert(ok.run_state === "validated", "pending_manual validates the run, so a PR can open while a human checks the manual items");
}

async function finalization() {
  console.log("\nrecord-review: the final report\n");
  const { db, run, r, b } = await issued({ manual: false });
  const draftText = readFileSync(r.report_path, "utf-8");
  const v = verdictFor(b);
  const res = await record(db, run.run_id, v);
  assert(res.outcome === "pass" && res.run_state === "validated" && getRun(db, run.run_id).state === "validated", "an approving verdict passes the attempt and validates the run");
  const final = readJson<Record<string, any>>(res.report_path);
  assert(schemaErrors("report", final).length === 0, "the final report validates against report.schema.json");
  assert(final.status === "complete" && final.outcome === "pass", "it is complete, with the outcome");
  assert(readFileSync(join(dirname(res.report_path), "report.draft.json"), "utf-8") === draftText, "the draft is kept as report.draft.json");
  assert(final.evidence[0].supports_criterion === "yes" && final.evidence[0].rationale === "the test exercises the criterion", "evidence carries the reviewer's judgment and rationale");
  assert(final.phases.at(-1).name === "review" && final.phases.at(-1).outcome === "pass", "a review phase is appended");
  assert(final.review.verdict_digest === res.verdict_digest && final.review.source_digest === b.source.digest, "the review block records the verdict and source digests");
  assert(final.review.sensitive_paths.length === 2 && final.review.modified_assertions[0].justified === true, "and the sign-offs and justifications");
  assert(readJson<V>(res.verdict_path).source_digest === b.source.digest && res.verdict_path.endsWith("attempts/1/review.json"), "the verdict is stored as attempts/{n}/review.json");
  const a = getAttempt(db, run.run_id, 1);
  assert(a.verdict_digest === res.verdict_digest && a.outcome === "pass" && a.owner_json === null, "the attempt row records the verdict digest and outcome");

  console.log("\nrecord-review: idempotency\n");
  const { findings, ...rest } = v;
  const reordered = JSON.stringify({ findings, ...rest }, null, 4);
  const again = await record(db, run.run_id, reordered);
  assert(again.noop && again.outcome === "pass" && again.verdict_digest === res.verdict_digest, "re-recording the same verdict (reformatted) is a no-op");
  assert(readFileSync(res.report_path, "utf-8") === JSON.stringify(final, null, 2) + "\n", "and leaves the report alone");
  const other = { ...v, findings: [{ severity: "advisory", detail: "a nit" }] };
  await rejects(() => record(db, run.run_id, other), /verdict_conflict/, "a different verdict for a complete attempt is rejected");
  assert(verdictDigest(JSON.parse(reordered)) === res.verdict_digest, "the digest ignores formatting and key order");
}

async function failures() {
  console.log("\nrecord-review: fail conditions\n");
  const cases: [string, (v: V) => V][] = [
    ["supports_criterion partial", (v) => ({ ...v, evidence: v.evidence.map((e) => (e.id === "AC-1.e1" ? { ...e, supports_criterion: "partial" } : e)) })],
    ["supports_criterion no", (v) => ({ ...v, evidence: v.evidence.map((e) => (e.id === "AC-2.e1" ? { ...e, supports_criterion: "no" } : e)) })],
    ["procedure_adequate no", (v) => ({ ...v, evidence: v.evidence.map((e) => (e.id === "AC-3.e1" ? { ...e, procedure_adequate: "no" } : e)) })],
    ["a sensitive concern", (v) => ({ ...v, sensitive_paths: v.sensitive_paths.map((x) => ({ ...x, signoff: x.path === "ci/static.sh" ? "concern" : "approve" })) })],
    ["an unjustified modified assertion", (v) => ({ ...v, modified_assertions: v.modified_assertions.map((m) => ({ ...m, justified: false })) })],
    ["a blocking finding", (v) => ({ ...v, findings: [{ severity: "blocking", detail: "leaks the token", location: "src/auth/refresh.ts:1" }] })],
  ];
  for (const [what, change] of cases) {
    const { db, run, b } = await issued();
    const res = await record(db, run.run_id, change(verdictFor(b)));
    const final = readJson<Record<string, any>>(res.report_path);
    const blocking = final.findings.filter((f: { severity: string; id: string }) => f.severity === "blocking").map((f: { id: string }) => f.id);
    assert(res.outcome === "fail" && res.run_state === "escalated" && blocking.length === 1, `${what} fails the attempt and escalates the run → ${blocking.join()}`);
  }
  {
    const { db, run, b } = await issued({ manual: false });
    const res = await record(db, run.run_id, { ...verdictFor(b), findings: [{ severity: "advisory", detail: "naming" }] });
    assert(res.outcome === "pass", "an advisory finding alone doesn't");
  }
}

async function recovery() {
  console.log("\nrecord-review: identity, crashes and deadlines\n");
  {
    const { db, root, run, b } = await issued();
    sh("git", ["commit", "-q", "--allow-empty", "-m", "later"], root);
    await rejects(() => record(db, run.run_id, verdictFor(b)), /revision_changed/, "a moved HEAD is caught before the verdict is stored");
    assert(getAttempt(db, run.run_id, 1).outcome === "error" && getAttempt(db, run.run_id, 1).verdict_digest === null, "the attempt is error, with no verdict");
  }
  {
    const { db, run, b } = await issued();
    const v = verdictFor(b);
    // A crash after the verdict was accepted, before the report was finalized.
    writeFileSync(join(run.artifact_dir, "attempts", "1", "review.json"), JSON.stringify(v));
    db.prepare("UPDATE factory_attempts SET verdict_digest = ? WHERE run_id = ? AND attempt = 1").run(verdictDigest(v), run.run_id);
    transitionAttempt(db, run.run_id, 1, "finalizing", { owner: { pid: 999999, start_time: null, command: "crashed", host: "h", since: new Date().toISOString() } });
    await rejects(() => record(db, run.run_id, { ...v, findings: [{ severity: "advisory", detail: "x" }] }), /verdict_conflict/, "a finalizing attempt takes only its own verdict");
    const res = await record(db, run.run_id, v);
    assert(res.refinalized && res.status === "complete" && res.outcome === "pending_manual", "the stored verdict finishes an interrupted finalization");
  }
  {
    const { db, run } = await awaiting();
    const shaped = { version: 1, source_digest: `sha256:${"0".repeat(64)}`, evidence: [], sensitive_paths: [], modified_assertions: [], findings: [] };
    await rejects(() => record(db, run.run_id, shaped), /not_issued.*review-input/s, "a verdict before review-input is rejected");
  }
  {
    const { db, run, b } = await issued({ manual: false });
    db.prepare("UPDATE factory_runs SET deadline_at = ? WHERE run_id = ?").run(new Date(Date.now() - 1000).toISOString(), run.run_id);
    const res = await record(db, run.run_id, verdictFor(b));
    assert(res.outcome === "pass", "a review in progress can still be recorded past the run deadline (§4.1)");
  }
}

try {
  await judgments();
  await sensitiveAtBase();
  await snapshot();
  await bundle();
  await completeness();
  await finalization();
  await failures();
  await recovery();
  console.log("\nAll factory review tests passed.");
} finally {
  cleanup();
}
