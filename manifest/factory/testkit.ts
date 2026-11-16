// Shared helpers for the factory test suites. Every test works in a fresh
// temporary directory and database; the real manifest is never opened.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

export function throws(fn: () => unknown, pattern: RegExp, msg: string): void {
  try {
    fn();
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ""} ${String(err)}`;
    assert(pattern.test(text), `${msg} (${String(err)})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

const tempDirs: string[] = [];

export function tempDir(prefix = "factory-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/** A git repository with one commit on `branch` and an optional origin URL. */
export function makeRepo(opts: { branch?: string; origin?: string; claudeMd?: string } = {}): string {
  const root = tempDir("factory-repo-");
  sh("git", ["init", "-q", "-b", opts.branch ?? "main"], root);
  if (opts.origin) sh("git", ["remote", "add", "origin", opts.origin], root);
  writeFileSync(join(root, "README.md"), "test\n");
  if (opts.claudeMd !== undefined) writeFileSync(join(root, "CLAUDE.md"), opts.claudeMd);
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", "init"], root);
  return root;
}

/** A fresh in-memory database at the latest schema. */
export async function memDb() {
  const { default: Database } = await import("better-sqlite3");
  const { migrate } = await import("../migrations.ts");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Insert a run row directly, bypassing `factory start`. */
export function seedRun(
  db: import("better-sqlite3").Database,
  runId: string,
  fields: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    run_id: runId,
    work_item: "w",
    repo: "o/r",
    worktree_path: "/wt",
    branch: "b",
    target_ref: "main",
    artifact_dir: "/artifacts",
    state: "planned",
    started_at: new Date().toISOString(),
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO factory_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((c) => row[c]),
  );
}
