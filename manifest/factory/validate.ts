import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FactoryError, atomicWrite, blocked } from "./util.ts";
import { requireExecutable, contractDigest, type AuthorizationRow } from "./runs.ts";
import { tx, getRun, getAttempt, transitionRun, transitionAttempt, recordEvent, type RunRow, type AttemptRow } from "./state.ts";
import { withLocks, worktreeLock, BUILD_LOCK } from "./locks.ts";
import { allocateAttempt, attemptDir } from "./attempts.ts";
import { runProcess, type ProcessResult } from "./process.ts";
import { readSettings, type FactorySettings, type LoadedSettings } from "./settings.ts";
import { parseContract, schemaErrors, type Contract, type Evidence } from "./schemas.ts";
import { assessTier, type TierAssessment } from "./tiers.ts";
import { captureIdentity, treeStatus, describeDirty, identityHolds, lockfileDigest, changedFiles, type Identity } from "./revision.ts";
import { classifyChanges, settingsAt, type Classification } from "./classify.ts";
import { parseFactorySettings } from "./settings.ts";
import { readResults, resultFiles, resolveSelector, executedCount, parseSelector, type TestCase } from "./junit.ts";
import { runStateForOutcome } from "./resume.ts";
import type { Owner } from "./owner.ts";

/**
 * `factory validate` (docs/FACTORY_DESIGN.md §4.3–§4.6): run the
 * deterministic phases for one attempt and write its draft report.
 *
 * 1. Preconditions, checked before an attempt is allocated. Any failure is
 *    blocked (exit 2) and changes nothing: no attempt is used and the run
 *    keeps its state, so the caller can fix the tree or settings and retry.
 * 2. Identity (HEAD, target, merge base) and a new attempt; the run moves
 *    to `validating`.
 * 3. setup, when configured and the lockfile changed since the last
 *    successful setup in this run (always on the first attempt).
 * 4. static: the `static` command, plus change classification (§4.6), the
 *    actual-diff tier (§4.5) and predicted-vs-actual drift.
 * 5. evidence: one `verify` run with fresh structured results, `command`
 *    evidence run on its own, `manual` evidence left pending.
 * 6. Post-check: HEAD unchanged and the tree still clean, else `error`.
 * 7. The report. All phases passing leaves the attempt `awaiting_review`
 *    for #62's reviewer; a failure or error completes it, which escalates
 *    the run (no fix loop in the first release).
 *
 * Both locks are held throughout: every phase is a build command.
 */

const PLUGIN_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".claude-plugin", "plugin.json");

export function runnerVersion(): string {
  try {
    return JSON.parse(readFileSync(PLUGIN_JSON, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function policyVersion(settingsDigest: string): string {
  return `factory@${runnerVersion()}+settings:${settingsDigest}`;
}

type PhaseName = "static" | "evidence";
type PhaseOutcome = "pass" | "fail" | "error" | "pending_manual";
type Phase = { name: PhaseName; outcome: PhaseOutcome; duration_s: number; log?: string };

type Executed = "passed" | "failed" | "skipped" | "not_found" | "error" | "not_run" | "pending_manual";
type EvidenceResult = {
  id: string;
  executed: Executed;
  supports_criterion: null;
  procedure_adequate?: null;
  exit_code?: number;
  log?: string;
  excerpt?: string;
};

type Finding = { id: string; severity: "blocking" | "advisory"; detail: string; location?: string; evidence_digest?: string };

export type Invocation = {
  id: string;
  phase: "setup" | "static" | "verify" | "evidence";
  command: string;
  started_at: string;
  duration_s: number;
  exit_code: number | null;
  outcome: ProcessResult["outcome"];
  reason: string | null;
  log: string;
  results?: { path: string; digest: string }[];
};

export type Report = {
  version: 1;
  run_id: string;
  attempt: number;
  status: AttemptRow["status"];
  outcome: "fail" | "error" | null;
  validation_scope: "branch";
  head_sha: string;
  merge_base_sha: string;
  target_ref: string;
  target_sha: string;
  contract_digest: string;
  policy_version: string;
  lockfile_digest: string | null;
  tree_clean_after: boolean;
  tier: { proposed: "standard" | "sensitive"; actual: "standard" | "sensitive"; reasons: string[] };
  changes: { new_evidence: number; modified_assertions: number; execution_policy: number };
  phases: Phase[];
  evidence: EvidenceResult[];
  findings: Finding[];
  flags: string[];
  budget: { attempts_used: number; wall_clock_s: number; tokens: null };
  invocations: Invocation[];
};

export type ValidateResult = {
  run_id: string;
  attempt: number;
  status: AttemptRow["status"];
  /** null while the attempt awaits review (all deterministic phases passed). */
  outcome: "fail" | "error" | null;
  failed_phase: string | null;
  report_path: string;
  tier: Report["tier"];
  run_state: RunRow["state"];
};

export type ValidateOptions = {
  owner: Owner;
  lockWaitMs: number;
  /** Overrides the command-timeout setting for each check. */
  timeoutMs?: number;
  graceMs?: number;
  echo?: boolean;
};

const STARTABLE = ["approved", "implementing", "validating"];
const OPEN_ATTEMPT = ["checks_running", "awaiting_review", "finalizing"];

// ── preconditions ────────────────────────────────────────────────────

type Prepared = {
  run: RunRow;
  authorization: AuthorizationRow;
  loaded: LoadedSettings;
  settings: FactorySettings;
  contract: Contract;
};

/** Everything checked before an attempt exists. Throws `blocked` for anything the caller can fix. */
function prepare(db: Database, runId: string, owner: Owner): Prepared {
  const { run, authorization } = requireExecutable(db, runId, owner);
  if (!STARTABLE.includes(run.state)) {
    throw new FactoryError("wrong_state", `run ${runId} is ${run.state}; validate runs while approved, implementing or validating`);
  }
  const open = db
    .prepare(`SELECT attempt, status FROM factory_attempts WHERE run_id = ? AND status IN (${OPEN_ATTEMPT.map(() => "?").join(", ")})`)
    .get(runId, ...OPEN_ATTEMPT) as { attempt: number; status: string } | undefined;
  if (open) {
    const next = open.status === "checks_running" ? "it is still running (or run `factory resume` if it crashed)" : "review it first";
    throw blocked("attempt_open", `attempt ${open.attempt} of ${runId} is ${open.status}; ${next}`);
  }

  const loaded = readSettings(run.worktree_path);
  if (loaded.errors.length) {
    throw blocked("bad_setting", `invalid Escapement Settings in ${loaded.source}: ${loaded.errors.map((e) => `${e.key}: ${e.message}`).join("; ")}`);
  }
  const settings = loaded.settings;

  const contractPath = join(run.artifact_dir, "contract.json");
  let content: Buffer;
  try {
    content = readFileSync(contractPath);
  } catch {
    throw blocked("contract_mismatch", `the approved contract is missing: ${contractPath}`);
  }
  if (contractDigest(content) !== authorization.contract_digest) {
    throw blocked("contract_mismatch", `${contractPath} no longer matches the approved contract (${authorization.contract_digest}); re-approve it`);
  }
  const contract = parseContract(content.toString("utf-8"), contractPath);

  const missing = settings.requiredChecks.filter((c) => settings[c] === null);
  if (missing.length) {
    throw blocked("not_configured", `required check${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not configured in Escapement Settings`);
  }
  const hasTests = evidenceOf(contract).some((e) => e.type === "test");
  if (hasTests && settings.verify === null) {
    throw blocked("not_configured", "the contract has test evidence but verify is not configured");
  }
  if (hasTests && settings.testResults === null) {
    throw blocked("not_configured", "the contract has test evidence but test-results is not configured");
  }

  const tree = treeStatus(run.worktree_path);
  if (!tree.clean) {
    throw blocked("dirty_tree", `worktree ${run.worktree_path} is not clean: ${describeDirty(tree)}`);
  }
  return { run, authorization, loaded, settings, contract };
}

function evidenceOf(contract: Contract): Evidence[] {
  return contract.criteria.flatMap((c) => c.evidence);
}

// ── helpers ──────────────────────────────────────────────────────────

function fileDigest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Failure output with run-specific noise removed, so the same failure digests the same (§5.3). */
export function normalizeFailure(text: string, worktree: string): string {
  return text
    .split(worktree)
    .join("<root>")
    .replace(/0x[0-9a-f]+/gi, "<addr>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/g, "<t>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\s+/g, " ")
    .trim();
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function tail(path: string, lines = 20): string {
  try {
    return readFileSync(path, "utf-8").split("\n").slice(-lines).join("\n").trim();
  } catch {
    return "";
  }
}

function excerpt(text: string, max = 500): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function lastSetupDigest(db: Database, runId: string): { found: boolean; digest: string | null } {
  const row = db
    .prepare(
      `SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change'
         AND json_extract(detail_json, '$.entity') = 'setup' ORDER BY id DESC LIMIT 1`,
    )
    .get(runId) as { detail_json: string } | undefined;
  if (!row) return { found: false, digest: null };
  return { found: true, digest: JSON.parse(row.detail_json).lockfile_digest ?? null };
}

/** Replace $FACTORY_RESULTS_DIR / ${FACTORY_RESULTS_DIR} in a test-results path. */
function expandResultsPath(path: string, resultsDir: string): string {
  return path.replace(/\$\{FACTORY_RESULTS_DIR\}|\$FACTORY_RESULTS_DIR\b/g, resultsDir);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ── the attempt ──────────────────────────────────────────────────────

class Attempt {
  readonly dir: string;
  readonly invocations: Invocation[] = [];
  private seq = 0;
  private readonly started = Date.now();

  constructor(
    readonly run: RunRow,
    readonly attempt: number,
    private readonly opts: ValidateOptions & { commandTimeoutMs: number },
  ) {
    this.dir = attemptDir(run.artifact_dir, attempt);
    mkdirSync(join(this.dir, "logs"), { recursive: true });
  }

  rel(path: string): string {
    return relative(this.dir, path).split(sep).join("/");
  }

  /** Milliseconds to the run deadline (Infinity without one). */
  remaining(): number {
    return this.run.deadline_at ? Date.parse(this.run.deadline_at) - Date.now() : Infinity;
  }

  elapsedS(): number {
    return (Date.now() - this.started) / 1000;
  }

  /** Run one command under the attempt: logged, timed out (capped by the run deadline), recorded as an invocation. */
  async exec(
    phase: Invocation["phase"],
    command: string,
    opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; captureStdout?: boolean } = {},
  ): Promise<ProcessResult & { invocation: Invocation }> {
    const id = `${++this.seq}-${phase}`;
    const want = opts.timeoutMs ?? this.opts.commandTimeoutMs;
    const limit = Math.min(want, this.remaining());
    const p = await runProcess({
      command,
      cwd: opts.cwd ?? this.run.worktree_path,
      env: { ...process.env, FACTORY_RUN_ID: this.run.run_id, FACTORY_ATTEMPT: String(this.attempt), ...opts.env },
      timeoutMs: limit,
      timeoutReason: limit < want ? "run_deadline" : "timeout",
      logPath: join(this.dir, "logs", `${id}.log`),
      graceMs: this.opts.graceMs,
      echo: this.opts.echo,
      captureStdout: opts.captureStdout,
    });
    const invocation: Invocation = {
      id,
      phase,
      command,
      started_at: p.started_at,
      duration_s: p.duration_ms / 1000,
      exit_code: p.exit_code,
      outcome: p.outcome,
      reason: p.reason,
      log: this.rel(p.log_path),
    };
    this.invocations.push(invocation);
    return { ...p, invocation };
  }
}

/** Run validation for `runId`. See the module comment for the steps. */
export async function validateRun(db: Database, runId: string, opts: ValidateOptions): Promise<ValidateResult> {
  // Fail fast on what needs no lock; prepare() runs again under the locks.
  const first = prepare(db, runId, opts.owner);
  const run0 = first.run;
  const waitMs = Math.min(opts.lockWaitMs, Math.max(run0.deadline_at ? Date.parse(run0.deadline_at) - Date.now() : Infinity, 0));

  return withLocks(db, [worktreeLock(run0.worktree_path), BUILD_LOCK], opts.owner, { waitMs, runId }, async () => {
    const prep = prepare(db, runId, opts.owner);
    const { settings, contract } = prep;
    const worktree = prep.run.worktree_path;
    const identity = captureIdentity(worktree, prep.run.target_ref);
    const policy = policyVersion(prep.loaded.digest);

    const row = allocateAttempt(db, runId, {
      owner: opts.owner,
      headSha: identity.head_sha,
      targetSha: identity.target_sha,
      contractDigest: prep.authorization.contract_digest,
      policyVersion: policy,
      maxAttempts: settings.maxAttempts,
    });
    tx(db, () => {
      const r = getRun(db, runId);
      if (r.state === "approved") transitionRun(db, runId, "implementing", { owner: opts.owner, reason: "validate" });
      if (getRun(db, runId).state === "implementing") {
        transitionRun(db, runId, "validating", { owner: opts.owner, reason: `attempt ${row.attempt}` });
      }
    });
    const run = getRun(db, runId);
    const at = new Attempt(run, row.attempt, {
      ...opts,
      commandTimeoutMs: opts.timeoutMs ?? settings.commandTimeoutMs,
    });

    try {
      return await runPhases(db, at, { settings, contract, identity, policy, prep });
    } catch (err) {
      // An unexpected failure mid-attempt: complete it as an error rather than leave it running.
      const current = getAttempt(db, runId, row.attempt);
      if (current.status === "checks_running") {
        transitionAttempt(db, runId, row.attempt, "complete", {
          owner: null,
          outcome: "error",
          reason: `runner error: ${(err as Error).message}`,
        });
        const r = getRun(db, runId);
        if (r.state === "validating") {
          transitionRun(db, runId, runStateForOutcome("error"), { owner: opts.owner, reason: `attempt ${row.attempt}: error` });
        }
      }
      throw err;
    }
  });
}

async function runPhases(
  db: Database,
  at: Attempt,
  ctx: { settings: FactorySettings; contract: Contract; identity: Identity; policy: string; prep: Prepared },
): Promise<ValidateResult> {
  const { settings, contract, identity } = ctx;
  const run = at.run;
  const worktree = run.worktree_path;
  const evidence = evidenceOf(contract);
  const phases: Phase[] = [];
  const findings: Finding[] = [];
  const flags: string[] = [];
  const results = new Map<string, EvidenceResult>(evidence.map((e) => [e.id, { id: e.id, executed: "not_run", supports_criterion: null }]));
  let errorReason: string | null = null;
  const lockDigest = lockfileDigest(worktree, identity.head_sha);

  // ── classification, tier and drift (part of phase 1) ──
  const files = changedFiles(worktree, identity.merge_base_sha, identity.head_sha);
  const selectorFiles = evidence.flatMap((e) => (e.type === "test" ? [parseSelector(e.selector).path] : []));
  const classification: Classification = classifyChanges({
    worktree,
    base: identity.merge_base_sha,
    head: identity.head_sha,
    files,
    headSettings: settings,
    selectorFiles,
  });
  const baseSettings = parseFactorySettings(settingsAt(worktree, identity.merge_base_sha)).settings;
  const sensitivePaths = [...new Set([...settings.sensitivePaths, ...baseSettings.sensitivePaths])];
  const proposed = contract.risk_tier_proposed;
  const tier: TierAssessment = assessTier({
    files: files.map((f) => f.path),
    settings: { sensitivePaths, validationFiles: [] },
    proposed: classification.policy_reasons.length ? "sensitive" : proposed,
    reasons: [...(contract.risk_reasons ?? []), ...classification.policy_reasons],
  });
  for (const item of classification.items) {
    if (item.class === "modified_assertion") {
      findings.push({ id: `assertion:${item.location}`, severity: "advisory", detail: `modified assertion: ${item.detail}`, location: item.location });
    } else if (item.class === "execution_policy") {
      findings.push({ id: `policy:${item.location}`, severity: "advisory", detail: `execution policy change: ${item.detail}`, location: item.location });
    }
  }
  const predicted = (contract.predicted_files ?? []).map((p) => p.replace(/^\.\//, ""));
  if (predicted.length) {
    const actual = files.map((f) => f.path);
    const unpredicted = actual.filter((p) => !predicted.includes(p));
    const untouched = predicted.filter((p) => !actual.includes(p));
    if (unpredicted.length) flags.push(`drift: changed but not predicted: ${unpredicted.join(", ")}`);
    if (untouched.length) flags.push(`drift: predicted but unchanged: ${untouched.join(", ")}`);
  }

  // ── setup ──
  const phaseStart = Date.now();
  let staticOutcome: PhaseOutcome = "pass";
  let staticLog: string | undefined;
  if (settings.setup !== null) {
    const last = lastSetupDigest(db, run.run_id);
    const required = settings.requiredChecks.includes("setup");
    if (required || !last.found || last.digest !== lockDigest) {
      const p = await at.exec("setup", settings.setup);
      staticLog = p.invocation.log;
      if (p.outcome === "pass") {
        recordEvent(db, run.run_id, "state_change", { entity: "setup", to: "done", attempt: at.attempt, lockfile_digest: lockDigest });
      } else {
        staticOutcome = "error";
        errorReason = p.reason ? `setup ${p.reason}` : `setup failed (exit ${p.exit_code})`;
        findings.push({ id: "check:setup", severity: "blocking", detail: `${errorReason}: ${excerpt(tail(p.log_path, 10))}` });
      }
    }
  }

  // ── phase 1: static ──
  if (staticOutcome === "pass" && settings.static !== null) {
    const p = await at.exec("static", settings.static);
    staticLog = p.invocation.log;
    if (p.outcome === "error") {
      staticOutcome = "error";
      errorReason = `static ${p.reason}`;
      findings.push({ id: "check:static", severity: "blocking", detail: `static was stopped (${p.reason})` });
    } else if (p.outcome === "fail") {
      staticOutcome = "fail";
      const out = tail(p.log_path, 20);
      findings.push({
        id: "check:static",
        severity: "blocking",
        detail: `static failed (exit ${p.exit_code}): ${excerpt(out)}`,
        evidence_digest: digestOf(normalizeFailure(out, worktree)),
      });
    }
  }
  phases.push({ name: "static", outcome: staticOutcome, duration_s: (Date.now() - phaseStart) / 1000, ...(staticLog ? { log: staticLog } : {}) });

  // ── phase 2: evidence ──
  if (staticOutcome === "pass") {
    const ev = await evidencePhase(at, { settings, evidence, results, findings });
    phases.push(ev.phase);
    if (ev.errorReason) errorReason = ev.errorReason;
  }

  // ── post-check (§4.3) ──
  const post = identityHolds(worktree, identity.head_sha);
  if (!post.ok) {
    const headMoved = post.detail.startsWith("HEAD is");
    errorReason = headMoved ? "revision changed during validation" : "checks are not side-effect free";
    findings.push({ id: "identity", severity: "blocking", detail: `${errorReason}: ${post.detail}` });
  }

  // ── outcome ──
  const failedPhase = phases.find((p) => p.outcome === "fail" || p.outcome === "error")?.name ?? null;
  const outcome: Report["outcome"] =
    errorReason !== null || phases.some((p) => p.outcome === "error") ? "error" : failedPhase ? "fail" : null;
  const status: AttemptRow["status"] = outcome === null ? "awaiting_review" : "complete";

  const report: Report = {
    version: 1,
    run_id: run.run_id,
    attempt: at.attempt,
    status,
    outcome,
    validation_scope: "branch",
    head_sha: identity.head_sha,
    merge_base_sha: identity.merge_base_sha,
    target_ref: identity.target_ref,
    target_sha: identity.target_sha,
    contract_digest: ctx.prep.authorization.contract_digest,
    policy_version: ctx.policy,
    lockfile_digest: lockDigest,
    tree_clean_after: treeStatus(worktree).clean,
    tier: { proposed, actual: tier.tier, reasons: tier.reasons },
    changes: {
      new_evidence: classification.new_evidence,
      modified_assertions: classification.modified_assertions,
      execution_policy: classification.execution_policy,
    },
    phases,
    evidence: [...results.values()],
    findings,
    flags,
    budget: {
      attempts_used: at.attempt,
      wall_clock_s: Math.max(0, (Date.now() - Date.parse(run.started_at)) / 1000),
      tokens: null,
    },
    invocations: at.invocations,
  };
  const problems = schemaErrors("report", report);
  if (problems.length) throw new FactoryError("internal", `report for attempt ${at.attempt} is invalid: ${problems.join("; ")}`);
  const reportPath = join(at.dir, "report.json");
  atomicWrite(reportPath, JSON.stringify(report, null, 2) + "\n");

  return tx(db, () => {
    db.prepare(
      `UPDATE factory_attempts SET report_path = ?, failed_phase = ?, duration_s = ?, findings_json = ?, flags_json = ?
         WHERE run_id = ? AND attempt = ?`,
    ).run(reportPath, failedPhase, Math.round(at.elapsedS()), JSON.stringify(findings), JSON.stringify(flags), run.run_id, at.attempt);
    db.prepare("UPDATE factory_runs SET tier_proposed = ?, tier_actual = ?, policy_version = ? WHERE run_id = ?").run(
      proposed,
      tier.tier,
      ctx.policy,
      run.run_id,
    );
    if (status === "awaiting_review") {
      transitionAttempt(db, run.run_id, at.attempt, "awaiting_review", { owner: null });
    } else {
      transitionAttempt(db, run.run_id, at.attempt, "complete", { owner: null, outcome: outcome!, reason: errorReason ?? `${failedPhase} failed` });
      transitionRun(db, run.run_id, runStateForOutcome(outcome), { reason: `attempt ${at.attempt}: ${outcome}` });
    }
    return {
      run_id: run.run_id,
      attempt: at.attempt,
      status,
      outcome,
      failed_phase: failedPhase,
      report_path: reportPath,
      tier: report.tier,
      run_state: getRun(db, run.run_id).state,
    };
  });
}

/** Phase 2 (§4.4): one structured verify run, command evidence, manual evidence pending. */
async function evidencePhase(
  at: Attempt,
  ctx: { settings: FactorySettings; evidence: Evidence[]; results: Map<string, EvidenceResult>; findings: Finding[] },
): Promise<{ phase: Phase; errorReason: string | null }> {
  const { settings, evidence, results, findings } = ctx;
  const worktree = at.run.worktree_path;
  const start = Date.now();
  // Mutated by the closures below, so kept in an object TypeScript won't narrow.
  const st: { outcome: PhaseOutcome; errorReason: string | null } = { outcome: "pass", errorReason: null };
  let log: string | undefined;
  const fail = () => {
    if (st.outcome === "pass" || st.outcome === "pending_manual") st.outcome = "fail";
  };
  const error = (why: string) => {
    st.outcome = "error";
    st.errorReason ??= why;
  };

  const tests = evidence.filter((e): e is Extract<Evidence, { type: "test" }> => e.type === "test");
  const runVerify = settings.verify !== null && (tests.length > 0 || settings.requiredChecks.includes("verify"));
  if (runVerify) {
    const v = await verifyRun(at, settings);
    log = v.log;
    if (v.error) {
      error(v.error);
      findings.push({ id: "check:verify", severity: "blocking", detail: v.error });
      for (const t of tests) results.set(t.id, { ...results.get(t.id)!, executed: "error", log: v.log });
    } else {
      for (const t of tests) {
        const r = resolveSelector(t.selector, v.cases);
        const res: EvidenceResult = { id: t.id, executed: r.executed, supports_criterion: null, log: v.log };
        if (r.message) res.excerpt = excerpt(r.message);
        results.set(t.id, res);
        if (r.executed !== "passed") {
          fail();
          const what = r.executed === "not_found" ? "no executed test matches the selector" : r.executed;
          findings.push({
            id: `evidence:${t.id}`,
            severity: "blocking",
            detail: `${t.selector}: ${what}${r.message ? `: ${excerpt(r.message, 200)}` : ""}`,
            evidence_digest: digestOf(normalizeFailure(`${r.executed} ${r.message ?? ""}`, worktree)),
          });
        }
      }
      if (v.exitCode !== 0) {
        fail();
        findings.push({
          id: "check:verify",
          severity: "blocking",
          detail: `verify failed (exit ${v.exitCode}): ${v.failedCases.slice(0, 5).map((c) => c.name).join("; ") || excerpt(tail(join(at.dir, v.log!), 10), 300)}`,
        });
      }
    }
  }

  for (const e of evidence) {
    if (st.outcome === "error") break;
    if (e.type === "command") {
      const cwd = resolve(worktree, e.cwd ?? ".");
      if (!inside(cwd, worktree)) {
        results.set(e.id, { ...results.get(e.id)!, executed: "error" });
        error(`evidence ${e.id}: cwd ${e.cwd} is outside the worktree`);
        findings.push({ id: `evidence:${e.id}`, severity: "blocking", detail: `cwd ${e.cwd} is outside the worktree` });
        continue;
      }
      const p = await at.exec("evidence", e.run, {
        cwd,
        timeoutMs: e.timeout_s !== undefined ? Math.min(e.timeout_s * 1000, Number.MAX_SAFE_INTEGER) : undefined,
        captureStdout: true,
      });
      const stdout = p.stdout ?? "";
      const res: EvidenceResult = { id: e.id, executed: "passed", supports_criterion: null, log: p.invocation.log };
      if (p.exit_code !== null) res.exit_code = p.exit_code;
      const problems: string[] = [];
      if (p.outcome === "error") {
        res.executed = "error";
        problems.push(p.reason ?? "error");
      } else {
        if (p.exit_code !== e.expect.exit_code) problems.push(`exit ${p.exit_code}, expected ${e.expect.exit_code}`);
        if (e.expect.stdout_matches !== undefined && !new RegExp(e.expect.stdout_matches, "m").test(stdout)) {
          problems.push(`stdout does not match /${e.expect.stdout_matches}/`);
        }
        if (e.expect.stdout_not_matches !== undefined && new RegExp(e.expect.stdout_not_matches, "m").test(stdout)) {
          problems.push(`stdout matches /${e.expect.stdout_not_matches}/`);
        }
        if (problems.length) res.executed = "failed";
      }
      if (problems.length) {
        res.excerpt = excerpt(`${problems.join("; ")}\n${tail(p.log_path, 10)}`);
        findings.push({
          id: `evidence:${e.id}`,
          severity: "blocking",
          detail: `${e.run}: ${problems.join("; ")}`,
          evidence_digest: digestOf(normalizeFailure(`${problems.join("; ")} ${tail(p.log_path, 20)}`, worktree)),
        });
        if (res.executed === "error") error(`evidence ${e.id}: ${p.reason}`);
        else fail();
      }
      results.set(e.id, res);
    } else if (e.type === "manual") {
      results.set(e.id, { id: e.id, executed: "pending_manual", supports_criterion: null, procedure_adequate: null });
      if (st.outcome === "pass") st.outcome = "pending_manual";
    }
  }

  return {
    phase: { name: "evidence", outcome: st.outcome, duration_s: (Date.now() - start) / 1000, ...(log ? { log } : {}) },
    errorReason: st.errorReason,
  };
}

/**
 * The single structured verify run (§4.4 result freshness). Results count
 * only if this invocation produced them:
 *
 * - a fresh `results/{invocation}/` directory is `FACTORY_RESULTS_DIR`;
 * - a test-results path outside it is a fixed path: it is deleted before
 *   the command, must exist afterwards with an mtime after the start, and
 *   is copied into the fresh directory;
 * - missing results, unreadable results or zero executed tests are an
 *   error, never a pass, whatever verify's exit status.
 */
async function verifyRun(
  at: Attempt,
  settings: FactorySettings,
): Promise<{ cases: TestCase[]; failedCases: TestCase[]; exitCode: number | null; log?: string; error: string | null }> {
  const worktree = at.run.worktree_path;
  const invocationId = `${at.invocations.length + 1}-verify`;
  const resultsDir = join(at.dir, "results", invocationId);
  if (existsSync(resultsDir)) rmSync(resultsDir, { recursive: true, force: true });
  mkdirSync(resultsDir, { recursive: true });

  const spec = settings.testResults;
  const expanded = spec ? resolve(worktree, expandResultsPath(spec.path, resultsDir)) : null;
  const fixed = expanded !== null && !inside(expanded, resultsDir);
  if (fixed) rmSync(expanded!, { recursive: true, force: true });
  const startedMs = Date.now();

  const p = await at.exec("verify", settings.verify!, { env: { FACTORY_RESULTS_DIR: resultsDir } });
  const out = { cases: [] as TestCase[], failedCases: [] as TestCase[], exitCode: p.exit_code, log: p.invocation.log, error: null as string | null };
  if (p.outcome === "error") return { ...out, error: `verify was stopped (${p.reason})` };
  if (!spec || !expanded) return { ...out, error: "test-results is not configured" };

  let source = expanded;
  if (fixed) {
    if (!existsSync(expanded) || statSync(expanded).mtimeMs < startedMs - 1000) {
      return { ...out, error: `verify left no fresh results at ${expanded}` };
    }
    source = join(resultsDir, "fixed");
    cpSync(expanded, source, { recursive: true });
  }
  if (!existsSync(source)) {
    return { ...out, error: `verify wrote no results at ${spec.path} (exit ${p.exit_code})` };
  }
  const files = statSync(source).isDirectory() ? resultFiles(source) : [source];
  if (files.length === 0) return { ...out, error: `verify wrote no results under ${spec.path}` };
  p.invocation.results = files.map((f) => ({ path: at.rel(f), digest: fileDigest(f) }));
  let cases: TestCase[];
  try {
    cases = readResults(files);
  } catch (err) {
    return { ...out, error: (err as Error).message };
  }
  if (executedCount(cases) === 0) return { ...out, cases, error: "verify's results report zero executed tests" };
  return { ...out, cases, failedCases: cases.filter((c) => c.status === "failed" || c.status === "error") };
}
