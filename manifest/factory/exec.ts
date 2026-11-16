import type { Database } from "better-sqlite3";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, atomicWrite } from "./util.ts";
import { runProcess } from "./process.ts";
import { requireExecutable, deadlinePassed } from "./runs.ts";
import { transitionRun, getRun } from "./state.ts";
import { withLocks, worktreeLock, BUILD_LOCK } from "./locks.ts";
import type { Owner } from "./owner.ts";

export type ExecResult = {
  run_id: string;
  seq: number;
  command: string[];
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  /** pass: exit 0; fail: non-zero exit; error: killed by the runner. */
  outcome: "pass" | "fail" | "error";
  /** Why the runner killed it: `timeout`, `run_deadline`, `interrupted` or `spawn_failed`. */
  reason: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  log_path: string;
};

/** Exit status the CLI uses when the runner killed the command (as timeout(1) does). */
export const KILLED_EXIT = 124;

function nextSeq(dir: string): number {
  mkdirSync(dir, { recursive: true });
  const nums = readdirSync(dir)
    .map((f) => f.match(/^(\d+)\.json$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/**
 * Run a build or test command for a run (§4.1).
 *
 * 1. Refuse past the run deadline (the run is escalated) or without an
 *    active authorization.
 * 2. Take the worktree lock, then the build lock, waiting up to
 *    `lockWaitMs` (capped by the run deadline).
 * 3. Run it with runProcess in the run's worktree (own process group,
 *    timeout capped by the run deadline, group cleanup), logging to
 *    `{artifact_dir}/exec/{seq}.log`.
 * 4. Release the locks and write `{artifact_dir}/exec/{seq}.json`.
 *
 * The first exec after approval moves the run from approved to implementing.
 */
export async function execCommand(
  db: Database,
  runId: string,
  argv: string[],
  opts: {
    owner: Owner;
    timeoutMs: number;
    lockWaitMs: number;
    graceMs?: number;
    /** Copy the command's output to this process's stdout/stderr. */
    echo?: boolean;
  },
): Promise<ExecResult> {
  if (argv.length === 0) throw new FactoryError("usage", "exec needs a command after --");
  const { run } = requireExecutable(db, runId, opts.owner);
  if (!["approved", "implementing", "validating"].includes(run.state)) {
    throw new FactoryError("wrong_state", `run ${runId} is ${run.state}; exec runs while approved, implementing or validating`);
  }
  const remaining = () => (run.deadline_at ? Date.parse(run.deadline_at) - Date.now() : Infinity);

  return withLocks(
    db,
    [worktreeLock(run.worktree_path), BUILD_LOCK],
    opts.owner,
    { waitMs: Math.min(opts.lockWaitMs, Math.max(remaining(), 0)), runId },
    async () => {
      // Re-check now that we hold the locks: the wait may have been long.
      requireExecutable(db, runId, opts.owner);
      if (getRun(db, runId).state === "approved") {
        transitionRun(db, runId, "implementing", { owner: opts.owner, reason: "first exec" });
      }

      const dir = join(run.artifact_dir, "exec");
      const seq = nextSeq(dir);
      const deadlineCap = remaining();
      const limit = Math.min(opts.timeoutMs, deadlineCap);
      const p = await runProcess({
        command: argv,
        cwd: run.worktree_path,
        env: { ...process.env, FACTORY_RUN_ID: runId },
        timeoutMs: limit,
        timeoutReason: limit < opts.timeoutMs ? "run_deadline" : "timeout",
        logPath: join(dir, `${seq}.log`),
        graceMs: opts.graceMs,
        echo: opts.echo,
      });
      const result: ExecResult = { run_id: runId, seq, command: argv, cwd: run.worktree_path, ...p };
      atomicWrite(join(dir, `${seq}.json`), JSON.stringify(result, null, 2) + "\n");
      if (result.reason === "run_deadline" || deadlinePassed(getRun(db, runId))) {
        // Escalate now rather than at the next command.
        try {
          requireExecutable(db, runId, opts.owner);
        } catch {}
      }
      return result;
    },
  );
}

/** The CLI's exit status for an exec result: the command's own, or 124 if the runner killed it. */
export function execExitCode(r: ExecResult): number {
  if (r.outcome === "error") return KILLED_EXIT;
  return r.exit_code ?? 1;
}
