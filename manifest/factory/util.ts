import { mkdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

/**
 * Error codes the CLI reports. `blocked` errors mean the request was valid
 * but a precondition stopped it (deadline passed, lock not free, no active
 * authorization); the CLI exits 2 for them and 1 for everything else.
 */
export type ErrorKind = "error" | "blocked";

/** Quote for a POSIX shell: run IDs such as `owner-repo#42-r1` start a comment unquoted. */
export function shq(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export class FactoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly kind: ErrorKind = "error",
    /**
     * Machine-readable facts a caller routes on, beyond the code (#87:
     * `not_github`'s cause). The CLI reports it as `error.detail`, and only
     * when it is set, so no other error changes shape.
     */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FactoryError";
  }
}

export function blocked(code: string, message: string, detail?: Record<string, unknown>): FactoryError {
  return new FactoryError(code, message, "blocked", detail);
}

/** Current time as an ISO-8601 UTC string with millisecond precision. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse a duration such as `500ms`, `30s`, `15m`, `2h` or `1d` into milliseconds. */
export function parseDuration(text: string): number {
  const m = text.trim().match(DURATION_RE);
  if (!m) {
    throw new FactoryError("bad_duration", `invalid duration "${text}" (use e.g. 30s, 15m, 2h)`);
  }
  return Math.round(Number(m[1]) * UNIT_MS[m[2]]);
}

/**
 * Write a file atomically: write a temp file in the same directory, flush
 * it, then rename it over the target. Readers see the old or new content,
 * never a partial file.
 */
export function atomicWrite(path: string, data: string | Buffer): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(tmp, data);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Block the thread for `ms` milliseconds (the CLI is synchronous, like better-sqlite3). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Stable JSON: object keys sorted, so the same document always digests the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Digest of a JSON document's canonical form: formatting and key order don't change it. */
export function jsonDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
