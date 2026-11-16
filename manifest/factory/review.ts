import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FactoryError, atomicWrite, blocked, nowIso } from "./util.ts";
import { attemptDir, verdictPath } from "./attempts.ts";
import { changedFiles, identityHolds } from "./revision.ts";
import { settingsAt } from "./classify.ts";
import { parseFactorySettings } from "./settings.ts";
import { firstMatch } from "./glob.ts";
import { parseContract, schemaPath, schemaErrors, type Contract } from "./schemas.ts";
import { contractDigest, requireExecutable } from "./runs.ts";
import { tx, getRun, getAttempt, transitionAttempt, transitionRun, recordEvent, type AttemptRow, type RunRow, type RunState } from "./state.ts";
import { withLocks, worktreeLock } from "./locks.ts";
import { runStateForOutcome } from "./resume.ts";
import { promptPath } from "./prompts.ts";
import type { Owner } from "./owner.ts";
import type { Report } from "./validate.ts";

/**
 * The review phase (docs/FACTORY_DESIGN.md §4.9): what a complete verdict
 * must cover, and the read-only source snapshot the reviewer reads.
 */

// ── required judgments ───────────────────────────────────────────────

export type JudgmentKind = "supports_criterion" | "procedure_adequate";

export type RequiredJudgments = {
  /** Every contract evidence item, judged exactly once. */
  evidence: {
    id: string;
    criterion_id: string;
    criterion: string;
    type: "test" | "command" | "manual";
    kind: string;
    judgment: JudgmentKind;
    /** The runner's deterministic result from the draft report. */
    executed: string;
    /** The selector, command or instructions the contract gives. */
    spec: string;
  }[];
  /** Every changed sensitive path and every execution-policy change, signed off. */
  sensitive_paths: { path: string; reasons: string[] }[];
  /** Every modified-assertion location from phase 1, justified. */
  modified_assertions: { location: string; detail: string }[];
};

/** Executable evidence is judged on whether it supports its criterion; manual evidence on whether its procedure would. */
export function judgmentFor(type: string): JudgmentKind {
  return type === "manual" ? "procedure_adequate" : "supports_criterion";
}

/**
 * What a complete verdict for this attempt must cover. Computed only from
 * the contract, the draft report and git at the attempt's revisions, so
 * `review-input` and `record-review` always agree.
 *
 * Sensitive paths are changed files matching `sensitive-paths` at either
 * revision (as in validate), plus each `policy:{path}` finding: execution
 * policy changes make the run sensitive (§4.5), so they need a sign-off too.
 */
export function requiredJudgments(opts: {
  worktree: string;
  contract: Contract;
  draft: Report;
}): RequiredJudgments {
  const { worktree, contract, draft } = opts;
  const executed = new Map(draft.evidence.map((e) => [e.id, e.executed]));
  const evidence = contract.criteria.flatMap((c) =>
    c.evidence.map((e) => ({
      id: e.id,
      criterion_id: c.id,
      criterion: c.text,
      type: e.type,
      kind: e.kind,
      judgment: judgmentFor(e.type),
      executed: executed.get(e.id) ?? "not_run",
      spec: e.type === "test" ? e.selector : e.type === "command" ? e.run : e.instructions,
    })),
  );

  const patterns = (rev: string) => parseFactorySettings(settingsAt(worktree, rev)).settings.sensitivePaths;
  const sensitive = [...new Set([...patterns(draft.merge_base_sha), ...patterns(draft.head_sha)])];
  const reasons = new Map<string, string[]>();
  const add = (path: string, reason: string) => reasons.set(path, [...(reasons.get(path) ?? []), reason]);
  for (const f of changedFiles(worktree, draft.merge_base_sha, draft.head_sha)) {
    const pattern = firstMatch(f.path, sensitive);
    if (pattern) add(f.path, `sensitive path (matches ${pattern})`);
  }
  const modified: RequiredJudgments["modified_assertions"] = [];
  for (const f of draft.findings) {
    if (f.id.startsWith("policy:")) add(f.id.slice("policy:".length), f.detail);
    else if (f.id.startsWith("assertion:")) modified.push({ location: f.id.slice("assertion:".length), detail: f.detail });
  }
  const sensitive_paths = [...reasons.keys()].sort().map((path) => ({ path, reasons: reasons.get(path)! }));
  return { evidence, sensitive_paths, modified_assertions: modified };
}

// ── the source snapshot ──────────────────────────────────────────────

/** `attempts/{n}/review/`: the bundle the reviewer reads. */
export function reviewDir(artifactDir: string, attempt: number): string {
  return join(attemptDir(artifactDir, attempt), "review");
}

/**
 * Export `rev` with `git archive` into `dir` (replacing anything there) and
 * make its files read-only. Directories stay writable so the snapshot can
 * be replaced or cleaned up; the digest catches any change.
 */
export function exportSnapshot(worktree: string, rev: string, dir: string): string {
  removeSnapshot(dir);
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync("git", ["archive", "--format=tar", rev], { cwd: worktree, maxBuffer: 2 ** 31 - 1 });
  if (archive.status !== 0) {
    throw new FactoryError("git_failed", `git archive ${rev} failed: ${archive.stderr?.toString().trim() || archive.error?.message}`);
  }
  const tar = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive.stdout, maxBuffer: 2 ** 31 - 1 });
  if (tar.status !== 0) {
    throw new FactoryError("snapshot_failed", `extracting the snapshot failed: ${tar.stderr?.toString().trim() || tar.error?.message}`);
  }
  for (const f of walk(dir)) {
    const st = lstatSync(join(dir, f));
    if (st.isFile()) chmodSync(join(dir, f), st.mode & 0o111 ? 0o555 : 0o444);
  }
  return snapshotDigest(dir);
}

export function removeSnapshot(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Paths of the files and symlinks under `dir`, relative and `/`-separated, sorted. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * `sha256:` over every file's path, type (executable, plain or symlink) and
 * content digest, in path order. Recomputable at any time, so a changed
 * snapshot is detectable.
 */
export function snapshotDigest(dir: string): string {
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    const full = join(dir, rel);
    const st = lstatSync(full);
    const [type, content] = st.isSymbolicLink()
      ? ["link", Buffer.from(readlinkSync(full))]
      : [st.mode & 0o111 ? "exec" : "file", readFileSync(full)];
    h.update(`${rel}\0${type}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return `sha256:${h.digest("hex")}`;
}

// ── review-input: the bundle (§4.9) ──────────────────────────────────

export type Bundle = {
  version: 1;
  run_id: string;
  attempt: number;
  head_sha: string;
  merge_base_sha: string;
  target_ref: string;
  target_sha: string;
  /** The issue text the host passed with --issue-file; null when none was given. */
  issue: { path: string } | null;
  contract: { path: string; digest: string; content: Contract };
  /** `git diff merge_base_sha..head_sha`. */
  diff: string;
  /** Read-only `git archive` of head_sha. Read this, never the live worktree. */
  source: { path: string; digest: string };
  report: { path: string; tier: Report["tier"]; changes: Report["changes"]; flags: string[] };
  logs: string[];
  results: string[];
  required: RequiredJudgments;
  /** The verdict schema, where to write the verdict, and the command that records it. */
  verdict: { schema: string; write_to: string; record: string };
  /** The runner wrapper, and the prefix for any command the reviewer runs (through `factory exec`, under the locks). */
  runner: { path: string; exec: string };
  reviewer_prompt: string;
};

const FACTORY_SH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "factory.sh");

/** Quote for a POSIX shell: run IDs such as `#42-r1` start a comment unquoted. */
function shq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export type ReviewInputResult = {
  run_id: string;
  attempt: number;
  bundle_path: string;
  source_digest: string;
  /** True when an earlier, unchanged snapshot was kept. */
  reused_snapshot: boolean;
  required: { evidence: number; sensitive_paths: number; modified_assertions: number };
};

/** The draft report: kept as report.draft.json once finalization starts, report.json before. */
export function draftReportPath(artifactDir: string, attempt: number): string {
  const dir = attemptDir(artifactDir, attempt);
  const kept = join(dir, "report.draft.json");
  return existsSync(kept) ? kept : join(dir, "report.json");
}

function readJsonFile<T>(path: string, what: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    throw new FactoryError("unreadable", `cannot read ${what} ${path}: ${(err as Error).message}`);
  }
}

/** The attempt's contract, checked against the digest the attempt was validated with. */
function attemptContract(run: RunRow, a: AttemptRow): { path: string; contract: Contract } {
  const path = join(run.artifact_dir, "contract.json");
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    throw blocked("contract_mismatch", `the approved contract is missing: ${path}`);
  }
  if (contractDigest(content) !== a.contract_digest) {
    throw blocked("contract_mismatch", `${path} no longer matches the contract attempt ${a.attempt} was validated with (${a.contract_digest})`);
  }
  return { path, contract: parseContract(content.toString("utf-8"), path) };
}

/**
 * HEAD must still be the attempt's head_sha on a clean tree (§4.3). If not,
 * the attempt completes as `error` and the run escalates, as `resume` does,
 * and this throws `revision_changed`.
 */
function requireIdentity(db: Database, run: RunRow, a: AttemptRow, owner: Owner): void {
  const id = identityHolds(run.worktree_path, a.head_sha);
  if (id.ok) return;
  transitionAttempt(db, run.run_id, a.attempt, "complete", { owner: null, outcome: "error", reason: "revision changed during validation" });
  if (getRun(db, run.run_id).state === "validating") {
    transitionRun(db, run.run_id, runStateForOutcome("error"), { owner, reason: `attempt ${a.attempt}: error` });
  }
  throw new FactoryError("revision_changed", `attempt ${a.attempt} of ${run.run_id} is now error: revision changed during validation (${id.detail})`);
}

/**
 * The source digest `review-input` last issued for this attempt, or null.
 * Kept in a `state_change` event (entity `review`, to `issued`), like setup's
 * lockfile digest, so no schema change is needed.
 */
export function issuedDigest(db: Database, runId: string, attempt: number): string | null {
  const row = db
    .prepare(
      `SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'state_change'
         AND json_extract(detail_json, '$.entity') = 'review' AND json_extract(detail_json, '$.to') = 'issued'
         AND json_extract(detail_json, '$.attempt') = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, attempt) as { detail_json: string } | undefined;
  return row ? (JSON.parse(row.detail_json).source_digest ?? null) : null;
}

function lockWait(run: RunRow, lockWaitMs: number): number {
  return Math.min(lockWaitMs, Math.max(run.deadline_at ? Date.parse(run.deadline_at) - Date.now() : Infinity, 0));
}

/**
 * `factory review-input <run_id> <attempt>`: write the reviewer's bundle to
 * `attempts/{n}/review/` and return its path. It starts work, so it refuses
 * past the run deadline (§4.1). Calling it again for the same attempt (a
 * re-issued review) keeps the snapshot if it is unchanged.
 */
export async function reviewInput(
  db: Database,
  runId: string,
  attempt: number,
  opts: { owner: Owner; lockWaitMs: number; issueFile?: string },
): Promise<ReviewInputResult> {
  const run0 = requireExecutable(db, runId, opts.owner).run;
  return withLocks(db, [worktreeLock(run0.worktree_path)], opts.owner, { waitMs: lockWait(run0, opts.lockWaitMs), runId }, () => {
    const { run } = requireExecutable(db, runId, opts.owner);
    const a = getAttempt(db, runId, attempt);
    if (a.status !== "awaiting_review") {
      throw new FactoryError("wrong_state", `attempt ${attempt} of ${runId} is ${a.status}; only an attempt awaiting review can be reviewed`);
    }
    const { path: contractPath, contract } = attemptContract(run, a);
    requireIdentity(db, run, a, opts.owner);

    const dir = reviewDir(run.artifact_dir, attempt);
    mkdirSync(dir, { recursive: true });
    const draftPath = draftReportPath(run.artifact_dir, attempt);
    const draft = readJsonFile<Report>(draftPath, "draft report");

    const issuePath = join(dir, "issue.md");
    if (opts.issueFile !== undefined) {
      let text: string;
      try {
        text = readFileSync(opts.issueFile, "utf-8");
      } catch (err) {
        throw new FactoryError("usage", `cannot read --issue-file ${opts.issueFile}: ${(err as Error).message}`);
      }
      atomicWrite(issuePath, text);
    }

    const sourceDir = join(dir, "source");
    const before = issuedDigest(db, runId, attempt);
    const reused = before !== null && existsSync(sourceDir) && snapshotDigest(sourceDir) === before;
    const digest = reused ? before! : exportSnapshot(run.worktree_path, a.head_sha, sourceDir);

    const diffPath = join(dir, "diff.patch");
    const diff = spawnSync("git", ["diff", "--no-color", "--no-ext-diff", `${draft.merge_base_sha}..${a.head_sha}`], {
      cwd: run.worktree_path,
      maxBuffer: 2 ** 31 - 1,
    });
    if (diff.status !== 0) throw new FactoryError("git_failed", `git diff failed: ${diff.stderr?.toString().trim()}`);
    atomicWrite(diffPath, diff.stdout);

    const at = attemptDir(run.artifact_dir, attempt);
    const required = requiredJudgments({ worktree: run.worktree_path, contract, draft });
    const writeTo = join(dir, "verdict.json");
    const bundle: Bundle = {
      version: 1,
      run_id: runId,
      attempt,
      head_sha: a.head_sha,
      merge_base_sha: draft.merge_base_sha,
      target_ref: draft.target_ref,
      target_sha: draft.target_sha,
      issue: existsSync(issuePath) ? { path: issuePath } : null,
      contract: { path: contractPath, digest: a.contract_digest, content: contract },
      diff: diffPath,
      source: { path: sourceDir, digest },
      report: { path: draftPath, tier: draft.tier, changes: draft.changes, flags: draft.flags },
      logs: draft.invocations.map((i) => join(at, i.log)),
      results: draft.invocations.flatMap((i) => (i.results ?? []).map((r) => join(at, r.path))),
      required,
      verdict: {
        schema: schemaPath("verdict"),
        write_to: writeTo,
        record: `bash ${shq(FACTORY_SH)} record-review ${shq(runId)} ${attempt} ${shq(writeTo)}`,
      },
      runner: { path: FACTORY_SH, exec: `bash ${shq(FACTORY_SH)} exec ${shq(runId)} --` },
      reviewer_prompt: promptPath("reviewer"),
    };
    const bundlePath = join(dir, "bundle.json");
    atomicWrite(bundlePath, JSON.stringify(bundle, null, 2) + "\n");
    recordEvent(db, runId, "state_change", {
      entity: "review",
      to: "issued",
      attempt,
      source_digest: digest,
      head_sha: a.head_sha,
      reused_snapshot: reused,
      owner: opts.owner,
    });
    return {
      run_id: runId,
      attempt,
      bundle_path: bundlePath,
      source_digest: digest,
      reused_snapshot: reused,
      required: {
        evidence: required.evidence.length,
        sensitive_paths: required.sensitive_paths.length,
        modified_assertions: required.modified_assertions.length,
      },
    };
  });
}

// ── record-review: completeness and finalization (§4.7, §4.9) ────────

export type Verdict = {
  version: 1;
  source_digest: string;
  evidence: { id: string; supports_criterion?: "yes" | "no" | "partial"; procedure_adequate?: "yes" | "no"; rationale: string }[];
  sensitive_paths: { path: string; signoff: "approve" | "concern"; rationale: string }[];
  modified_assertions: { location: string; justified: boolean; rationale: string }[];
  findings: { severity: "blocking" | "advisory"; detail: string; location?: string }[];
};

type Outcome = "pass" | "fail" | "pending_manual" | "error";

export type RecordReviewResult = {
  run_id: string;
  attempt: number;
  status: AttemptRow["status"];
  outcome: Outcome;
  report_path: string;
  verdict_path: string;
  verdict_digest: string;
  run_state: RunState;
  /** The same verdict was already recorded; nothing changed. */
  noop: boolean;
  /** An interrupted finalization was completed from the stored verdict. */
  refinalized: boolean;
};

/** Stable JSON: object keys sorted, so the same verdict always digests the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest of a verdict's canonical JSON: formatting and key order don't change it. */
export function verdictDigest(verdict: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(verdict)).digest("hex")}`;
}

/**
 * Completeness (§4.9): `source_digest` is the issued snapshot's; every
 * required evidence ID is judged exactly once with its judgment kind; every
 * required sensitive path is signed off and every modified-assertion
 * location justified, exactly once; nothing unknown. Empty means complete.
 */
export function verdictProblems(v: Verdict, required: RequiredJudgments, issued: string): string[] {
  const problems: string[] = [];
  if (v.source_digest !== issued) {
    problems.push(`source_digest ${v.source_digest} is not the snapshot issued for this attempt (${issued})`);
  }
  const check = <T>(
    what: string,
    entries: T[],
    keyOf: (e: T) => string,
    wanted: Map<string, string>,
    missing: (k: string) => string,
    extra?: (e: T, k: string) => string | null,
  ) => {
    const seen = new Map<string, number>();
    for (const e of entries) {
      const k = keyOf(e);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (!wanted.has(k)) problems.push(`${what} ${k}: not one this attempt requires`);
      else {
        const p = extra?.(e, k);
        if (p) problems.push(p);
      }
    }
    for (const k of wanted.keys()) {
      const n = seen.get(k) ?? 0;
      if (n === 0) problems.push(missing(k));
      else if (n > 1) problems.push(`${what} ${k}: given ${n} times; give it once`);
    }
  };
  const kinds = new Map(required.evidence.map((e) => [e.id, e.judgment]));
  check(
    "evidence",
    v.evidence,
    (e) => e.id,
    kinds,
    (k) => `evidence ${k}: no judgment (needs ${kinds.get(k)})`,
    (e, k) => {
      const want = kinds.get(k)!;
      return e[want] === undefined ? `evidence ${k}: judge ${want}, not ${want === "supports_criterion" ? "procedure_adequate" : "supports_criterion"}` : null;
    },
  );
  check(
    "sensitive path",
    v.sensitive_paths,
    (s) => s.path,
    new Map(required.sensitive_paths.map((s) => [s.path, ""])),
    (k) => `sensitive path ${k}: no sign-off`,
  );
  check(
    "modified assertion",
    v.modified_assertions,
    (m) => m.location,
    new Map(required.modified_assertions.map((m) => [m.location, ""])),
    (k) => `modified assertion ${k}: no justification`,
  );
  return problems;
}

type Finding = Report["findings"][number];

/** The findings a verdict adds, each blocking one a reason the attempt fails (§4.9). */
function reviewFindings(v: Verdict): Finding[] {
  const out: Finding[] = [];
  for (const e of v.evidence) {
    if (e.supports_criterion === "no" || e.supports_criterion === "partial") {
      out.push({ id: `judgment:${e.id}`, severity: "blocking", detail: `reviewer: evidence supports its criterion: ${e.supports_criterion}: ${e.rationale}` });
    } else if (e.procedure_adequate === "no") {
      out.push({ id: `judgment:${e.id}`, severity: "blocking", detail: `reviewer: manual procedure is not adequate: ${e.rationale}` });
    }
  }
  for (const s of v.sensitive_paths) {
    if (s.signoff === "concern") out.push({ id: `signoff:${s.path}`, severity: "blocking", detail: `reviewer concern: ${s.rationale}`, location: s.path });
  }
  for (const m of v.modified_assertions) {
    if (!m.justified) out.push({ id: `justification:${m.location}`, severity: "blocking", detail: `modified assertion not justified: ${m.rationale}`, location: m.location });
  }
  v.findings.forEach((f, i) => out.push({ id: `review:${i + 1}`, severity: f.severity, detail: f.detail, ...(f.location ? { location: f.location } : {}) }));
  return out;
}

function recordedResult(db: Database, run: RunRow, a: AttemptRow, extra: { noop: boolean; refinalized: boolean }): RecordReviewResult {
  return {
    run_id: run.run_id,
    attempt: a.attempt,
    status: a.status,
    outcome: a.outcome as Outcome,
    report_path: a.report_path ?? join(attemptDir(run.artifact_dir, a.attempt), "report.json"),
    verdict_path: verdictPath(run.artifact_dir, a.attempt),
    verdict_digest: a.verdict_digest!,
    run_state: getRun(db, run.run_id).state,
    ...extra,
  };
}

/** Write the final report from the kept draft and the stored verdict, complete the attempt, advance the run. */
function finalize(
  db: Database,
  run: RunRow,
  a: AttemptRow,
  verdict: Verdict,
  digest: string,
  owner: Owner,
  refinalized: boolean,
): RecordReviewResult {
  const dir = attemptDir(run.artifact_dir, a.attempt);
  const reportPath = join(dir, "report.json");
  const keptPath = join(dir, "report.draft.json");
  if (!existsSync(keptPath)) atomicWrite(keptPath, readFileSync(reportPath));
  const draft = readJsonFile<Report>(keptPath, "draft report");

  const judged = new Map(verdict.evidence.map((e) => [e.id, e]));
  const evidence = draft.evidence.map((e) => {
    const j = judged.get(e.id);
    if (!j) return e;
    return j.procedure_adequate !== undefined
      ? { ...e, procedure_adequate: j.procedure_adequate, rationale: j.rationale }
      : { ...e, supports_criterion: j.supports_criterion!, rationale: j.rationale };
  });
  const added = reviewFindings(verdict);
  const failed = added.some((f) => f.severity === "blocking");
  const manual = draft.evidence.some((e) => e.executed === "pending_manual");
  const outcome: Outcome = failed ? "fail" : manual ? "pending_manual" : "pass";
  const recordedAt = nowIso();
  const final = {
    ...draft,
    status: "complete",
    outcome,
    phases: [...draft.phases, { name: "review", outcome: failed ? "fail" : "pass" }],
    evidence,
    findings: [...draft.findings, ...added],
    review: {
      verdict: "review.json",
      verdict_digest: digest,
      source_digest: verdict.source_digest,
      recorded_at: recordedAt,
      sensitive_paths: verdict.sensitive_paths,
      modified_assertions: verdict.modified_assertions,
    },
  };
  const problems = schemaErrors("report", final);
  if (problems.length) throw new FactoryError("internal", `final report for attempt ${a.attempt} is invalid: ${problems.join("; ")}`);
  atomicWrite(reportPath, JSON.stringify(final, null, 2) + "\n");

  return tx(db, () => {
    db.prepare("UPDATE factory_attempts SET report_path = ?, findings_json = ? WHERE run_id = ? AND attempt = ?").run(
      reportPath,
      JSON.stringify(final.findings),
      run.run_id,
      a.attempt,
    );
    transitionAttempt(db, run.run_id, a.attempt, "complete", { owner: null, outcome, reason: "review recorded" });
    if (getRun(db, run.run_id).state === "validating") {
      transitionRun(db, run.run_id, runStateForOutcome(outcome), { owner, reason: `attempt ${a.attempt}: ${outcome}` });
    }
    recordEvent(db, run.run_id, "state_change", { entity: "verdict", to: "recorded", attempt: a.attempt, verdict_digest: digest, outcome, owner });
    return recordedResult(db, run, getAttempt(db, run.run_id, a.attempt), { noop: false, refinalized });
  });
}

/**
 * `factory record-review <run_id> <attempt> <file>` (§4.9): check the
 * verdict, re-check identity, store it as `review.json`, finalize the
 * report and complete the attempt.
 *
 * - A malformed verdict (`invalid_verdict`) or an incomplete one
 *   (`incomplete_verdict`, every problem listed) is blocked: nothing is
 *   written and the attempt stays `awaiting_review`.
 * - Idempotent by verdict digest: the same verdict for a complete attempt
 *   is a no-op; a different one is `verdict_conflict`. The same verdict
 *   for a `finalizing` attempt (a crash mid-finalization) finishes it.
 * - Bookkeeping, so it works past the run deadline (§4.1); a run that was
 *   escalated meanwhile stays escalated.
 */
export async function recordReview(
  db: Database,
  runId: string,
  attempt: number,
  verdictText: string,
  opts: { owner: Owner; lockWaitMs: number; source?: string },
): Promise<RecordReviewResult> {
  const run0 = getRun(db, runId);
  if (run0.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
  return withLocks(db, [worktreeLock(run0.worktree_path)], opts.owner, { waitMs: opts.lockWaitMs, runId }, () => {
    const run = getRun(db, runId);
    if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
    const a = getAttempt(db, runId, attempt);
    const reject = (code: string, problems: string[]): never => {
      recordEvent(db, runId, "state_change", { entity: "verdict", to: "rejected", attempt, code, problems, owner: opts.owner });
      const what = opts.source ? `verdict ${opts.source}` : "verdict";
      throw blocked(code, `${what} rejected; attempt ${attempt} still awaits review:\n  - ${problems.join("\n  - ")}`);
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(verdictText);
    } catch (err) {
      if (a.status !== "awaiting_review") throw blocked("invalid_verdict", `the verdict is not JSON: ${(err as Error).message}`);
      return reject("invalid_verdict", [`not JSON: ${(err as Error).message}`]);
    }
    const digest = verdictDigest(parsed);

    if (a.status === "complete") {
      if (a.verdict_digest === digest) return recordedResult(db, run, a, { noop: true, refinalized: false });
      if (a.verdict_digest) {
        throw blocked("verdict_conflict", `attempt ${attempt} of ${runId} already has a different verdict (${a.verdict_digest}); a complete attempt's verdict can't change`);
      }
      throw new FactoryError("wrong_state", `attempt ${attempt} of ${runId} completed without review (${a.outcome ?? "no outcome"})`);
    }
    if (a.status === "finalizing" && a.verdict_digest !== digest) {
      throw blocked("verdict_conflict", `attempt ${attempt} of ${runId} is finalizing another verdict (${a.verdict_digest})`);
    }
    if (a.status !== "awaiting_review" && a.status !== "finalizing") {
      throw new FactoryError("wrong_state", `attempt ${attempt} of ${runId} is ${a.status}; only an attempt awaiting review takes a verdict`);
    }

    const shape = schemaErrors("verdict", parsed);
    if (shape.length) return reject("invalid_verdict", shape);
    const verdict = parsed as Verdict;
    const { contract } = attemptContract(run, a);
    const issued = issuedDigest(db, runId, attempt);
    if (issued === null) throw blocked("not_issued", `no review was issued for attempt ${attempt} of ${runId}; run factory review-input first`);
    const draft = readJsonFile<Report>(draftReportPath(run.artifact_dir, attempt), "draft report");
    const problems = verdictProblems(verdict, requiredJudgments({ worktree: run.worktree_path, contract, draft }), issued);
    if (problems.length) return reject("incomplete_verdict", problems);

    requireIdentity(db, run, a, opts.owner);

    if (a.status === "awaiting_review") {
      atomicWrite(verdictPath(run.artifact_dir, attempt), JSON.stringify(verdict, null, 2) + "\n");
      tx(db, () => {
        db.prepare("UPDATE factory_attempts SET verdict_digest = ? WHERE run_id = ? AND attempt = ?").run(digest, runId, attempt);
        transitionAttempt(db, runId, attempt, "finalizing", { owner: opts.owner, reason: "verdict accepted" });
      });
    }
    return finalize(db, run, getAttempt(db, runId, attempt), verdict, digest, opts.owner, a.status === "finalizing");
  });
}
