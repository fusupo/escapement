import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { nowIso } from "./util.ts";

/**
 * The operation that holds a lock or owns an attempt (§4.1, §4.7). `resume`
 * uses it to tell a live owner from a crashed one.
 */
export type Owner = {
  pid: number;
  /** Process start time, so a reused pid is not mistaken for the original owner. */
  start_time: string | null;
  command: string;
  host: string;
  since: string;
};

/**
 * When `pid` started, as an opaque string compared only for equality.
 * Linux: field 22 of /proc/{pid}/stat (clock ticks since boot). Elsewhere:
 * `ps -o lstart=`. Null when the process does not exist or can't be read.
 */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The command name (field 2) is in parentheses and may contain spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    if (process.platform === "linux") return null;
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function currentOwner(command: string, pid: number = process.pid): Owner {
  return { pid, start_time: processStartTime(pid), command, host: hostname(), since: nowIso() };
}

/**
 * Whether the owner's process is still running. An owner on another host
 * can't be checked and is treated as alive (the shared DB is per user and
 * normally on one machine).
 */
export function isAlive(owner: Owner): boolean {
  if (owner.host !== hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (owner.start_time === null) return true;
  return processStartTime(owner.pid) === owner.start_time;
}

export function parseOwner(json: string | null): Owner | null {
  return json ? (JSON.parse(json) as Owner) : null;
}
