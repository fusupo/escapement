import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { migrate } from "./migrations.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * Read context-path from the CLAUDE.md in the repo root (parent of
 * manifest/) and resolve it against that root.
 */
function resolveContextPath(): string | null {
  const repoRoot = resolve(__dirname, "..");
  const claudeMd = resolve(repoRoot, "CLAUDE.md");
  if (!existsSync(claudeMd)) return null;

  const raw = parseContextPath(readFileSync(claudeMd, "utf-8"), (line) =>
    console.error(
      `manifest: warning: ${claudeMd}:${line}: context-path outside "## Escapement Settings" is ignored`,
    ),
  );
  return raw === null ? null : resolve(repoRoot, raw);
}

/**
 * Get or create a SQLite database instance at the given path.
 * If no dataDir is provided, derives the path from CLAUDE.md context-path,
 * falling back to {repo-root}/../escapement-ctx/manifest/manifest.db.
 */
export function getDb(dataDir?: string): DatabaseType {
  let dbPath: string;
  if (dataDir) {
    dbPath = resolve(dataDir, "manifest.db");
  } else {
    const contextPath = resolveContextPath();
    const base = contextPath ?? resolve(__dirname, "..", "..", "escapement-ctx");
    dbPath = resolve(base, "manifest", "manifest.db");
  }

  // Ensure parent directory exists
  const parentDir = dirname(dbPath);
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
export function initManifest(dataDir?: string): DatabaseType {
  const db = getDb(dataDir);
  try {
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
