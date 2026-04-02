import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "schema.sql");

/**
 * Parse context-path from the project's CLAUDE.md.
 * Walks up from the manifest directory to find CLAUDE.md,
 * then extracts the context-path setting.
 */
function resolveContextPath(): string | null {
  // Look for CLAUDE.md in the repo root (parent of manifest/)
  const repoRoot = resolve(__dirname, "..");
  const claudeMd = resolve(repoRoot, "CLAUDE.md");
  if (!existsSync(claudeMd)) return null;

  const content = readFileSync(claudeMd, "utf-8");
  // Match: - **context-path**: <value>
  const match = content.match(/\*\*context-path\*\*:\s*(.+)/);
  if (!match) return null;

  const raw = match[1].trim();
  // Resolve relative to repo root
  return resolve(repoRoot, raw);
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
 * Apply the V2 schema to a SQLite instance.
 * Safe to call on a fresh database. Will error if tables already exist
 * (use ensureSchema for idempotent setup).
 */
export function applySchema(db: DatabaseType): void {
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  db.exec(sql);
}

/**
 * Idempotent schema setup: only applies if work_items table doesn't exist.
 */
export function ensureSchema(db: DatabaseType): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'"
    )
    .get() as { name: string } | undefined;

  if (row) {
    return false;
  }
  applySchema(db);
  return true;
}

/**
 * Initialize the manifest database: create/open the SQLite instance
 * and ensure the schema is applied.
 */
export function initManifest(dataDir?: string): DatabaseType {
  const db = getDb(dataDir);
  ensureSchema(db);
  return db;
}
