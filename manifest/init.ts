import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { migrate } from "./migrations.ts";

const SETTINGS_HEADING_RE = /^##[ \t]+Escapement Settings[ \t]*$/;
const HEADING_RE = /^##?[ \t]/;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^[ \t]*(`+|~+)[ \t]*$/;
const SETTING_RE = /^[ \t]*[-*][ \t]+\*\*context-path\*\*:[ \t]*(.*)$/;

/**
 * Extract the context-path value from CLAUDE.md content.
 *
 * Same rules as scripts/get-context-path.sh (keep them in sync; the shared
 * fixtures in scripts/fixtures/context-path.md are checked by test-init.ts):
 * only the first "## Escapement Settings" section counts, up to the next
 * "#" or "##" heading; fenced code blocks are ignored; the value is the rest
 * of the line with trailing whitespace trimmed and one pair of surrounding
 * quotes or backticks removed. Unfenced settings outside the section are
 * ignored and reported through `warn` with their 1-based line number.
 *
 * Returns null when the setting is absent or empty.
 */
export function parseContextPath(
  content: string,
  warn: (line: number) => void = () => {},
): string | null {
  let fence = "";
  let inSection = false;
  let seenSection = false;
  let value: string | null = null;

  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");

    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = "";
      return;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = open[1];
      return;
    }

    if (HEADING_RE.test(line)) {
      inSection = !seenSection && SETTINGS_HEADING_RE.test(line);
      if (inSection) seenSection = true;
      return;
    }

    const setting = line.match(SETTING_RE);
    if (!setting) return;
    if (!inSection) {
      warn(i + 1);
      return;
    }
    if (value === null) value = stripQuotes(setting[1].replace(/[ \t]+$/, ""));
  });

  return value ? value : null;
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  if (first === s[s.length - 1] && (first === '"' || first === "'" || first === "`")) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * The project whose manifest the CLI operates on.
 *
 * - An explicit `projectRoot` is used as given (resolved against `cwd`); it
 *   must exist.
 * - Otherwise, inside a git repository, the main worktree's root, so every
 *   linked worktree of a project shares one manifest.
 * - Otherwise `cwd`.
 */
export function resolveProjectRoot(opts: { projectRoot?: string; cwd?: string } = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.projectRoot) {
    const root = resolve(cwd, opts.projectRoot);
    // A mistyped root would otherwise silently get a new, empty manifest.
    if (!existsSync(root)) throw new Error(`manifest: project root does not exist: ${root}`);
    return root;
  }
  return gitMainWorktree(cwd) ?? cwd;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Root of the main worktree of the repository containing `cwd`, or null when
 * `cwd` is not in a git work tree. `git worktree list` always lists the main
 * worktree first. For a bare repository, which has no main work tree, the
 * current linked worktree's root is used instead.
 */
function gitMainWorktree(cwd: string): string | null {
  const toplevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return null;
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!list) return toplevel;
  const [first] = list.split("\n\n");
  const lines = first.split("\n");
  if (lines.includes("bare") || !lines[0].startsWith("worktree ")) return toplevel;
  return lines[0].slice("worktree ".length);
}

export type DbLocation = {
  dbPath: string;
  /** Project root the path was resolved from; null when dataDir was given. */
  root: string | null;
  /** True when the project sets no context-path and the DB lives in the repo. */
  inRepo: boolean;
};

/**
 * Where the manifest database lives.
 *
 * `dataDir` overrides everything: `{dataDir}/manifest.db`. Otherwise the
 * project root comes from resolveProjectRoot, its CLAUDE.md context-path
 * (Escapement Settings section only) is resolved against that root, and the
 * DB is `{context-path}/manifest/manifest.db`. Without a context-path it is
 * `{root}/manifest/manifest.db`. The plugin's own CLAUDE.md is never read.
 */
export function resolveDbPath(
  opts: {
    dataDir?: string;
    projectRoot?: string;
    cwd?: string;
    warn?: (message: string) => void;
  } = {},
): DbLocation {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.dataDir) {
    return { dbPath: resolve(cwd, opts.dataDir, "manifest.db"), root: null, inRepo: false };
  }

  const warn = opts.warn ?? ((m: string) => console.error(m));
  const root = resolveProjectRoot({ projectRoot: opts.projectRoot, cwd });
  const claudeMd = resolve(root, "CLAUDE.md");
  const raw = existsSync(claudeMd)
    ? parseContextPath(readFileSync(claudeMd, "utf-8"), (line) =>
        warn(
          `manifest: warning: ${claudeMd}:${line}: context-path outside "## Escapement Settings" is ignored`,
        ),
      )
    : null;

  if (raw === null) {
    return { dbPath: resolve(root, "manifest", "manifest.db"), root, inRepo: true };
  }
  return { dbPath: resolve(root, raw, "manifest", "manifest.db"), root, inRepo: false };
}

export type ManifestOptions = { dataDir?: string; projectRoot?: string };

/**
 * Get or create a SQLite database instance at the location given by
 * resolveDbPath.
 */
export function getDb(opts: ManifestOptions = {}): DatabaseType {
  const { dbPath, inRepo } = resolveDbPath(opts);

  const parentDir = dirname(dbPath);
  if (!existsSync(dbPath) && inRepo) {
    console.error(
      `manifest: no context-path in Escapement Settings; creating the manifest inside the repo at ${dbPath}`,
    );
  }
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const db = new Database(dbPath);
  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  // Enable foreign key enforcement (off by default in SQLite)
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * Bring a SQLite instance up to the latest schema by running any pending
 * migrations (see migrations.ts). Idempotent, so it is safe on fresh and
 * existing databases alike.
 */
export function applySchema(db: DatabaseType): void {
  migrate(db);
}

/**
 * Initialize the manifest database: create/open the SQLite instance
 * and run any pending schema migrations.
 */
export function initManifest(opts: ManifestOptions = {}): DatabaseType {
  const db = getDb(opts);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
