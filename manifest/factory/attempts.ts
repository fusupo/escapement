import type { Database } from "better-sqlite3";
import { join } from "node:path";
import { blocked, nowIso } from "./util.ts";
import { tx, getRun, getAttempt, recordEvent, type AttemptRow } from "./state.ts";
import type { Owner } from "./owner.ts";

/** `{artifact_dir}/attempts/{n}/`: report, logs, results and the reviewer verdict (§4.2). */
export function attemptDir(artifactDir: string, attempt: number): string {
  return join(artifactDir, "attempts", String(attempt));
}

export function verdictPath(artifactDir: string, attempt: number): string {
  return join(attemptDir(artifactDir, attempt), "review.json");
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
