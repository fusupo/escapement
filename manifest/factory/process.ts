import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { nowIso } from "./util.ts";

export type ProcessResult = {
  exit_code: number | null;
  signal: string | null;
  /** pass: exit 0; fail: non-zero exit; error: killed by the runner or failed to start. */
  outcome: "pass" | "fail" | "error";
  /** Why: `timeout`, `run_deadline`, `interrupted` or `spawn_failed`; null when the command ended on its own. */
  reason: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  log_path: string;
  /** Everything the command wrote to stdout, when `captureStdout` was set. */
  stdout?: string;
};

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

/**
 * Run one command with the factory's execution guarantees (§4.1):
 *
 * - it starts in its own process group, in `cwd`;
 * - stdout and stderr go to `logPath` (and to this process's, with `echo`);
 * - after `timeoutMs`, or on a SIGINT/SIGTERM to the runner, the whole
 *   group gets SIGTERM, then SIGKILL after `graceMs`. `timeoutReason`
 *   names the timeout (`run_deadline` when the run deadline set it);
 * - when the command exits, anything it left running in its group is
 *   killed too.
 *
 * `command` is an argv array, or a string run with `sh -c` (project
 * settings are written as shell command lines).
 */
export async function runProcess(opts: {
  command: string[] | string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  timeoutReason?: string;
  logPath: string;
  graceMs?: number;
  echo?: boolean;
  captureStdout?: boolean;
}): Promise<ProcessResult> {
  const argv = typeof opts.command === "string" ? ["sh", "-c", opts.command] : opts.command;
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const log = createWriteStream(opts.logPath);
  const startedAt = new Date();
  const chunks: Buffer[] = [];

  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    detached: true, // own process group, so the whole tree can be killed
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? process.env,
  });

  let reason: string | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (why: string) => {
    if (reason || child.pid === undefined) return;
    reason = why;
    killGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => killGroup(child.pid!, "SIGKILL"), opts.graceMs ?? 5000);
  };
  const timer = setTimeout(() => stop(opts.timeoutReason ?? "timeout"), Math.max(opts.timeoutMs, 0));
  const onSignal = () => stop("interrupted");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  child.stdout.on("data", (b: Buffer) => {
    log.write(b);
    if (opts.captureStdout) chunks.push(b);
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
  return {
    exit_code: exit.code,
    signal: exit.signal,
    outcome: reason || spawnError ? "error" : exit.code === 0 ? "pass" : "fail",
    reason: reason ?? (spawnError ? "spawn_failed" : null),
    started_at: nowIso(startedAt),
    ended_at: nowIso(endedAt),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    log_path: opts.logPath,
    ...(opts.captureStdout ? { stdout: Buffer.concat(chunks).toString("utf-8") } : {}),
  };
}
