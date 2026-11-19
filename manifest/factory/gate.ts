import type { Database } from "better-sqlite3";
import { git } from "./context.ts";
import { tx, recordEvent, type RunRow } from "./state.ts";
import { diffStat, identityHolds } from "./revision.ts";
import type { FactorySettings } from "./settings.ts";
import type { ReportView } from "./report-section.ts";
import type { Owner } from "./owner.ts";

/**
 * The gate in report-only mode (docs/FACTORY_DESIGN.md §6.3, #110). For the
 * report a PR shows, it recommends `auto_merge` only when every rule holds,
 * and `ping` otherwise, with one reason per failed rule. Report-only: the
 * recommendation is recorded and shown, the operator is always notified,
 * and nothing is ever merged.
 *
 * `evaluateGate` is pure, so every rule can be tested with a true and a
 * false fact. `gatherFacts` reads them from the report, the run and the
 * worktree; `recordGate` stores the result on the run and as a `gate` event.
 */

export const GATE_RULES = [
  "tier",
  "outcome",
  "modified_assertions",
  "execution_policy",
  "head",
  "contract_digest",
  "advisories",
  "diff_lines",
  "diff_files",
  "attempts",
] as const;
export type GateRule = (typeof GATE_RULES)[number];

export type GateCheck = { rule: GateRule; ok: boolean; detail: string };
export type GateRecommendation = "auto_merge" | "ping";
export type GateResult = {
  mode: "report-only";
  recommendation: GateRecommendation;
  /** One per failed rule, in rule order; empty for auto_merge. */
  reasons: string[];
  /** Every rule with its result, for the event and for tests. */
  checks: GateCheck[];
};

export type GateLimits = { maxDiffLines: number; maxDiffFiles: number; maxAdvisories: number; maxAttempts: number };

export type GateFacts = {
  tier: { actual: string; reasons: string[] };
  outcome: string | null;
  /** Evidence still awaiting a manual outcome, when the outcome is pending_manual. */
  pendingManual: string[];
  modifiedAssertions: { count: number; findings: string[] };
  executionPolicy: { count: number; findings: string[] };
  head: { ok: boolean; detail: string };
  contractDigest: { report: string; authorized: string | null };
  /** Advisory findings, not counting the assertion: and policy: ones (their own rules). */
  advisories: string[];
  /** The diff's size, or null with why it couldn't be measured. */
  diff: { files: number; lines: number } | { unknown: string };
  attempts: number;
};

export function gateLimits(s: Pick<FactorySettings, "gateMaxDiffLines" | "gateMaxDiffFiles" | "gateMaxAdvisories" | "gateMaxAttempts">): GateLimits {
  return { maxDiffLines: s.gateMaxDiffLines, maxDiffFiles: s.gateMaxDiffFiles, maxAdvisories: s.gateMaxAdvisories, maxAttempts: s.gateMaxAttempts };
}

/** At most `max` items, then "and N more". */
function some(items: readonly string[], max = 5): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
}

export function evaluateGate(f: GateFacts, limits: GateLimits): GateResult {
  const checks: GateCheck[] = [];
  const check = (rule: GateRule, ok: boolean, detail: string) => checks.push({ rule, ok, detail });

  check(
    "tier",
    f.tier.actual === "standard",
    f.tier.actual === "standard"
      ? "actual tier is standard"
      : `actual tier is ${f.tier.actual}${f.tier.reasons.length ? `: ${some(f.tier.reasons, 3)}` : ""}`,
  );

  if (f.outcome === "pass") check("outcome", true, "outcome is pass");
  else if (f.outcome === "pending_manual")
    check("outcome", false, `outcome is pending_manual: awaiting manual checks${f.pendingManual.length ? ` ${some(f.pendingManual)}` : ""}`);
  else check("outcome", false, `outcome is ${f.outcome ?? "unknown"}, not pass`);

  const ma = f.modifiedAssertions;
  const maCount = Math.max(ma.count, ma.findings.length);
  check(
    "modified_assertions",
    maCount === 0,
    maCount === 0 ? "no modified assertions" : `modified assertions: ${maCount}${ma.findings.length ? ` (${some(ma.findings)})` : ""}`,
  );

  const ep = f.executionPolicy;
  const epCount = Math.max(ep.count, ep.findings.length);
  check(
    "execution_policy",
    epCount === 0,
    epCount === 0 ? "no execution policy changes" : `execution policy changes: ${epCount}${ep.findings.length ? ` (${some(ep.findings)})` : ""}`,
  );

  check("head", f.head.ok, f.head.ok ? "the report's head is the branch head" : `the report's head is not the branch head: ${f.head.detail}`);

  const digestOk = f.contractDigest.authorized !== null && f.contractDigest.report === f.contractDigest.authorized;
  check(
    "contract_digest",
    digestOk,
    digestOk
      ? "the report's contract is the authorized one"
      : `the report was validated against ${f.contractDigest.report}, the authorization is for ${f.contractDigest.authorized ?? "nothing (no active authorization)"}`,
  );

  check(
    "advisories",
    f.advisories.length <= limits.maxAdvisories,
    `${f.advisories.length} advisory finding${f.advisories.length === 1 ? "" : "s"}${
      f.advisories.length > limits.maxAdvisories ? `, over gate-max-advisories (${limits.maxAdvisories}): ${some(f.advisories)}` : ` (gate-max-advisories ${limits.maxAdvisories})`
    }`,
  );

  if ("unknown" in f.diff) {
    // Never passes silently: an unmeasured diff is not a small one.
    check("diff_lines", false, `diff size unknown, lines not counted: ${f.diff.unknown}`);
    check("diff_files", false, `diff size unknown, files not counted: ${f.diff.unknown}`);
  } else {
    const { lines, files } = f.diff;
    check(
      "diff_lines",
      lines <= limits.maxDiffLines,
      `diff is ${lines} line${lines === 1 ? "" : "s"}${lines > limits.maxDiffLines ? `, over gate-max-diff-lines (${limits.maxDiffLines})` : ` (gate-max-diff-lines ${limits.maxDiffLines})`}`,
    );
    check(
      "diff_files",
      files <= limits.maxDiffFiles,
      `diff is ${files} file${files === 1 ? "" : "s"}${files > limits.maxDiffFiles ? `, over gate-max-diff-files (${limits.maxDiffFiles})` : ` (gate-max-diff-files ${limits.maxDiffFiles})`}`,
    );
  }

  check(
    "attempts",
    f.attempts <= limits.maxAttempts,
    `the run used ${f.attempts} attempt${f.attempts === 1 ? "" : "s"}${
      f.attempts > limits.maxAttempts ? `, over gate-max-attempts (${limits.maxAttempts})` : ` (gate-max-attempts ${limits.maxAttempts})`
    }`,
  );

  const reasons = checks.filter((c) => !c.ok).map((c) => c.detail);
  return { mode: "report-only", recommendation: reasons.length === 0 ? "auto_merge" : "ping", reasons, checks };
}

/** The report fields the gate reads. Reports always have them; older or hand-built views may lack the optional ones. */
export type GateReport = Pick<ReportView, "outcome" | "head_sha" | "target_sha" | "contract_digest" | "tier" | "evidence" | "findings"> & {
  merge_base_sha?: string;
  changes?: { new_evidence: number; modified_assertions: number; execution_policy: number };
};

/** The diff the report validated: merge base to head, as the tier and classification measure it. */
function measureDiff(worktree: string, report: GateReport): GateFacts["diff"] {
  try {
    const base = report.merge_base_sha || git(["merge-base", report.target_sha, report.head_sha], worktree);
    return diffStat(worktree, base, report.head_sha);
  } catch (err) {
    return { unknown: String((err as Error).message).split("\n")[0] };
  }
}

/** Read the gate's facts for `report`, the current report of `run`. */
export function gatherFacts(db: Database, run: RunRow, report: GateReport, authorizedDigest: string | null): GateFacts {
  const findings = report.findings ?? [];
  const ids = (prefix: string) => findings.filter((f) => f.id.startsWith(prefix)).map((f) => f.id.slice(prefix.length));
  const attempts = (db.prepare("SELECT COUNT(*) AS n FROM factory_attempts WHERE run_id = ?").get(run.run_id) as { n: number }).n;
  return {
    tier: { actual: report.tier.actual, reasons: report.tier.reasons ?? [] },
    outcome: report.outcome,
    pendingManual: report.outcome === "pending_manual" ? report.evidence.filter((e) => e.executed === "pending_manual").map((e) => e.id) : [],
    modifiedAssertions: { count: report.changes?.modified_assertions ?? 0, findings: ids("assertion:") },
    executionPolicy: { count: report.changes?.execution_policy ?? 0, findings: ids("policy:") },
    head: identityHolds(run.worktree_path, report.head_sha),
    contractDigest: { report: report.contract_digest, authorized: authorizedDigest },
    advisories: findings.filter((f) => f.severity === "advisory" && !f.id.startsWith("assertion:") && !f.id.startsWith("policy:")).map((f) => f.id),
    diff: measureDiff(run.worktree_path, report),
    attempts,
  };
}

/** What the gate was worked out for: the report a PR shows. */
export type GateContext = { attempt: number; report_revision: number; head_sha: string; outcome: string | null; limits: GateLimits; owner: Owner };

export type GateEvent = GateResult & Omit<GateContext, "owner"> & { owner: Owner };

/** The run's latest gate event, or null. */
export function latestGate(db: Database, runId: string): GateEvent | null {
  const row = db
    .prepare("SELECT detail_json FROM factory_events WHERE run_id = ? AND kind = 'gate' ORDER BY id DESC LIMIT 1")
    .get(runId) as { detail_json: string } | undefined;
  return row ? (JSON.parse(row.detail_json) as GateEvent) : null;
}

/**
 * Record a gate result on the run (gate_recommendation, gate_reasons_json:
 * always the latest) and as a `gate` event. A result unchanged since the
 * latest event (same recommendation and reasons, for the same attempt,
 * report revision and head) adds no event, so rerunning `factory pr` after
 * a crash records the gate once.
 */
export function recordGate(db: Database, runId: string, result: GateResult, ctx: GateContext): { changed: boolean } {
  return tx(db, () => {
    db.prepare("UPDATE factory_runs SET gate_recommendation = ?, gate_reasons_json = ? WHERE run_id = ?").run(
      result.recommendation,
      JSON.stringify(result.reasons),
      runId,
    );
    const last = latestGate(db, runId);
    const same =
      last !== null &&
      last.recommendation === result.recommendation &&
      JSON.stringify(last.reasons) === JSON.stringify(result.reasons) &&
      last.attempt === ctx.attempt &&
      last.report_revision === ctx.report_revision &&
      last.head_sha === ctx.head_sha;
    if (same) return { changed: false };
    recordEvent(db, runId, "gate", { ...result, ...ctx });
    return { changed: true };
  });
}
