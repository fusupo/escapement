import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { migrate } from "./migrations.ts";

const SETTINGS_HEADING_RE = /^##[ \t]+Escapement Settings[ \t]*$/;
const HEADING_RE = /^##?[ \t]/;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^[ \t]*(`+|~+)[ \t]*$/;
const SETTING_RE = /^[ \t]*[-*][ \t]+\*\*([A-Za-z0-9][A-Za-z0-9_-]*)\*\*:[ \t]*(.*)$/;

/**
 * Read every setting in the "## Escapement Settings" section of CLAUDE.md
 * content, as a map from key to raw value. Keys are
 * case-sensitive, as in get-context-path.sh.
 *
 * Same section rules as scripts/get-context-path.sh (keep them in sync; the
 * shared fixtures in scripts/fixtures/context-path.md are checked by
 * test-init.ts): only the first "## Escapement Settings" section counts, up
 * to the next "#" or "##" heading; fenced code blocks are ignored; a setting
 * is a list item "- **key**: value", whose value is the rest of the line with
 * trailing whitespace trimmed and one pair of surrounding quotes or backticks
 * removed. The first occurrence of a key wins, even when its value is empty.
 *
 * An unfenced context-path line outside the section is ignored and reported
 * through `warn` with its 1-based line number. Other bold list items outside
 * the section are ordinary documentation and are skipped silently.
 */
export function parseEscapementSettings(
  content: string,
  warn: (line: number) => void = () => {},
): Map<string, string> {
  let fence = "";
  let inSection = false;
  let seenSection = false;
  const settings = new Map<string, string>();

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
    const key = setting[1];
    if (!inSection) {
      if (key === "context-path") warn(i + 1);
      return;
    }
    if (!settings.has(key)) settings.set(key, stripQuotes(setting[2].replace(/[ \t]+$/, "")));
  });

  return settings;
}

/**
 * Extract the context-path value from CLAUDE.md content, using the rules of
 * parseEscapementSettings. Returns null when the setting is absent or empty.
 */
export function parseContextPath(
  content: string,
  warn: (line: number) => void = () => {},
): string | null {
  return parseEscapementSettings(content, warn).get("context-path") || null;
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
 * Where the manifest database lives.
 *
 * There is one manifest per user, shared by every project: work items carry
 * their repo, and dependencies cross repos. The location never depends on
 * the current project or on where the plugin is installed.
 *
 * 1. `dataDir` (the CLI's --data-dir): `{dataDir}/manifest.db`
 * 2. `ESCAPEMENT_MANIFEST_DIR`: `{dir}/manifest.db`
 * 3. `${XDG_DATA_HOME:-~/.local/share}/escapement/manifest.db`
 *
 * Relative paths resolve against the current directory.
 */
export function resolveDbPath(
  opts: { dataDir?: string; env?: NodeJS.ProcessEnv; home?: string; cwd?: string } = {},
): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const dir =
    opts.dataDir ||
    env.ESCAPEMENT_MANIFEST_DIR ||
    resolve(env.XDG_DATA_HOME || join(opts.home ?? homedir(), ".local", "share"), "escapement");
  return resolve(cwd, dir, "manifest.db");
}

export type ManifestOptions = { dataDir?: string };

/**
 * Get or create the SQLite database at the location given by resolveDbPath.
 */
export function getDb(opts: ManifestOptions = {}): DatabaseType {
  const dbPath = resolveDbPath(opts);
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
