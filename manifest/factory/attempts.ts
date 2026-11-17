import type { Database } from "better-sqlite3";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, atomicWrite, blocked, nowIso } from "./util.ts";
import { tx, getRun, getAttempt, recordEvent, transitionAttempt, type AttemptError, type AttemptRow, type RunRow } from "./state.ts";
import { schemaErrors } from "./schemas.ts";
import type { ReportView } from "./report-section.ts";
import type { Owner } from "./owner.ts";

/** `{artifact_dir}/attempts/{n}/`: report, logs, results and the reviewer verdict (§4.2). */
export function attemptDir(artifactDir: string, attempt: number): string {
  return join(artifactDir, "attempts", String(attempt));
}

export function verdictPath(artifactDir: string, attempt: number): string {
  return join(attemptDir(artifactDir, attempt), "review.json");
}

/**
 * The attempt's current report (§5.5): the highest revision
 * `report.r{k}.json` that record-manual wrote, else `report.json`. Earlier
 * revisions are never changed. Revision 1 is `report.json`.
 */
export function latestReportPath(artifactDir: string, attempt: number): { path: string; revision: number } {
  const dir = attemptDir(artifactDir, attempt);
  let best = 1;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(/^report\.r([1-9]\d*)\.json$/);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
  }
  return { path: join(dir, best === 1 ? "report.json" : `report.r${best}.json`), revision: best };
}

/**
 * The run's current report: the latest complete attempt's highest
 * revision, or null when no attempt has completed with a report.
 */
export function currentReport(
  db: Database,
  run: RunRow,
): { report: ReportView & { contract_digest: string }; path: string; revision: number; attempt: number } | null {
  const row = db
    .prepare("SELECT attempt FROM factory_attempts WHERE run_id = ? AND status = 'complete' ORDER BY attempt DESC LIMIT 1")
    .get(run.run_id) as { attempt: number } | undefined;
  if (!row) return null;
  const { path, revision } = latestReportPath(run.artifact_dir, row.attempt);
  if (!existsSync(path)) return null;
  let report: ReportView;
  try {
    report = JSON.parse(readFileSync(path, "utf-8")) as ReportView;
  } catch (err) {
    throw new FactoryError("unreadable", `cannot read report ${path}: ${(err as Error).message}`);
  }
  return { report: { ...report, revision }, path, revision, attempt: row.attempt };
}

/**
 * Allocate the run's next attempt (§4.7): numbered MAX + 1 and inserted as
 * `checks_running`, owned by the caller, in one IMMEDIATE transaction and
 * before any command runs. Concurrent callers get distinct numbers;
 * UNIQUE(run_id, attempt) backs that up. Interrupted attempts keep their
 * number, so they count toward `maxAttempts`.
 */
export function allocateAttempt(
  db: Database,
  runId: string,
  opts: {
    owner: Owner;
    headSha: string;
    targetSha?: string | null;
    contractDigest: string;
    policyVersion: string;
    maxAttempts?: number;
  },
): AttemptRow {
  return tx(db, () => {
    const run = getRun(db, runId);
    if (run.state === "closed") throw blocked("run_closed", `run ${runId} is closed`);
    const { n } = db.prepare("SELECT COALESCE(MAX(attempt), 0) AS n FROM factory_attempts WHERE run_id = ?").get(runId) as {
      n: number;
    };
    if (opts.maxAttempts !== undefined && n >= opts.maxAttempts) {
      throw blocked("attempt_budget", `run ${runId} has used all ${opts.maxAttempts} attempts`);
    }
    const attempt = n + 1;
    db.prepare(
      `INSERT INTO factory_attempts (run_id, attempt, status, owner_json, head_sha, target_sha, contract_digest,
         policy_version, started_at) VALUES (?, ?, 'checks_running', ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      attempt,
      JSON.stringify(opts.owner),
      opts.headSha,
      opts.targetSha ?? null,
      opts.contractDigest,
      opts.policyVersion,
      nowIso(),
    );
    recordEvent(db, runId, "state_change", { entity: "attempt", attempt, from: null, to: "checks_running", owner: opts.owner });
    return getAttempt(db, runId, attempt);
  });
}

/**
 * Complete an attempt as `error` when no command is left to write its final
 * report: the identity re-check at review time (review-input,
 * record-review) and `resume` (§4.7). The draft is kept as
 * `report.draft.json`, as finalization keeps it, and `report.json` becomes
 * the final report with the outcome, the structured cause (§5.4) and a
 * blocking `identity` finding, so every error attempt's report says why.
 * The caller decides the run's next state.
 */
export function completeWithError(
  db: Database,
  run: RunRow,
  attempt: number,
  error: AttemptError,
  opts: { owner?: Owner | null; detail?: string } = {},
): AttemptRow {
  const dir = attemptDir(run.artifact_dir, attempt);
  const reportPath = join(dir, "report.json");
  const keptPath = join(dir, "report.draft.json");
  const finding = { id: "identity", severity: "blocking" as const, detail: opts.detail ? `${error.reason}: ${opts.detail}` : error.reason };
  let findings: unknown[] | null = null;
  if (existsSync(reportPath) || existsSync(keptPath)) {
    if (!existsSync(keptPath)) copyFileSync(reportPath, keptPath);
    let draft: Record<string, unknown> | null = null;
    try {
      draft = JSON.parse(readFileSync(keptPath, "utf-8"));
    } catch {
      draft = null;
    }
    if (draft) {
      findings = [...((draft.findings as unknown[]) ?? []), finding];
      const final = { ...draft, status: "complete", outcome: "error", error, findings };
      const problems = schemaErrors("report", final);
      if (problems.length) throw new FactoryError("internal", `error report for attempt ${attempt} is invalid: ${problems.join("; ")}`);
      atomicWrite(reportPath, JSON.stringify(final, null, 2) + "\n");
    }
  }
  return tx(db, () => {
    if (findings) {
      db.prepare("UPDATE factory_attempts SET report_path = ?, findings_json = ? WHERE run_id = ? AND attempt = ?").run(
        reportPath,
        JSON.stringify(findings),
        run.run_id,
        attempt,
      );
    }
    return transitionAttempt(db, run.run_id, attempt, "complete", { owner: opts.owner ?? null, outcome: "error", reason: error.reason, error });
  });
}
