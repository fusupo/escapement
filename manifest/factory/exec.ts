import type { Database } from "better-sqlite3";
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FactoryError, atomicWrite, nowIso } from "./util.ts";
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
  /** Why the runner killed it: `timeout`, `run_deadline` or `interrupted`. */
  reason: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  log_path: string;
};

/** Exit status the CLI uses when the runner killed the command (as timeout(1) does). */
export const KILLED_EXIT = 124;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

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
 * 3. Start the command in its own process group in the run's worktree,
 *    logging stdout and stderr to `{artifact_dir}/exec/{seq}.log`.
 * 4. On timeout (capped by the run deadline) or a SIGINT/SIGTERM to the
 *    runner, SIGTERM the whole group, then SIGKILL it after `graceMs`.
 *    When the command exits, anything it left running in its group is
 *    killed too.
 * 5. Release the locks and write `{artifact_dir}/exec/{seq}.json`.
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
      const logPath = join(dir, `${seq}.log`);
      const log = createWriteStream(logPath);
      const startedAt = new Date();
      const deadlineCap = remaining();
      const limit = Math.min(opts.timeoutMs, deadlineCap);
      const reasonIfTimeout = limit < opts.timeoutMs ? "run_deadline" : "timeout";

      const child = spawn(argv[0], argv.slice(1), {
        cwd: run.worktree_path,
        detached: true, // own process group, so the whole tree can be killed
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FACTORY_RUN_ID: runId },
      });

      let reason: string | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (why: string) => {
        if (reason || child.pid === undefined) return;
        reason = why;
        killGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(child.pid!, "SIGKILL"), opts.graceMs ?? 5000);
      };
      const timer = setTimeout(() => stop(reasonIfTimeout), Math.max(limit, 0));
      const onSignal = () => stop("interrupted");
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      child.stdout.on("data", (b: Buffer) => {
        log.write(b);
        if (opts.echo) process.stdout.write(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        log.write(b);
        if (opts.echo) process.stderr.write(b);
      });

      // Listen for "close" now: it can fire in the same tick as "exit".
      const closed = new Promise<void>((r) => child.on("close", () => r()));
      let spawnError: Error | null = null;
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
        child.on("error", (err) => {
          spawnError = err;
          resolveExit({ code: null, signal: null });
        });
        child.on("exit", (code, signal) => {
          // Clean up anything the command left behind in its group; it would
          // otherwise keep running (and keep our pipes open).
          if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
          resolveExit({ code, signal });
        });
      });
      if (!spawnError) await closed;

      clearTimeout(timer);
      clearTimeout(killTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (spawnError) log.write(`factory: failed to start ${argv[0]}: ${(spawnError as Error).message}\n`);
      await new Promise<void>((r) => log.end(r));

      const endedAt = new Date();
      const result: ExecResult = {
        run_id: runId,
        seq,
        command: argv,
        cwd: run.worktree_path,
        exit_code: exit.code,
        signal: exit.signal,
        outcome: reason || spawnError ? "error" : exit.code === 0 ? "pass" : "fail",
        reason: reason ?? (spawnError ? "spawn_failed" : null),
        started_at: nowIso(startedAt),
        ended_at: nowIso(endedAt),
        duration_ms: endedAt.getTime() - startedAt.getTime(),
        log_path: logPath,
      };
      atomicWrite(join(dir, `${seq}.json`), JSON.stringify(result, null, 2) + "\n");
      if (reason === "run_deadline" || deadlinePassed(getRun(db, runId))) {
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
