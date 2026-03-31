import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, "schema.sql");

/**
 * Get or create a PGlite database instance at the given data directory.
 * If no dataDir is provided, defaults to {context-path}/manifest/pgdata/
 * where context-path is ../escapement-ctx relative to the repo root.
 */
export async function getDb(
  dataDir?: string
): Promise<PGlite> {
  const resolvedDir =
    dataDir ?? resolve(__dirname, "..", "..", "escapement-ctx", "manifest", "pgdata");
  const db = await PGlite.create(resolvedDir);
  return db;
}

/**
 * Apply the V2 schema to a PGlite instance.
 * Safe to call on a fresh database. Will error if tables already exist
 * (use ensureSchema for idempotent setup).
 */
export async function applySchema(db: PGlite): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf-8");
  await db.exec(sql);
}

/**
 * Idempotent schema setup: only applies if work_items table doesn't exist.
 */
export async function ensureSchema(db: PGlite): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'work_items'
    ) AS exists
  `);
  if (result.rows[0].exists) {
    return false;
  }
  await applySchema(db);
  return true;
}

/**
 * Initialize the manifest database: create/open the PGlite instance
 * and ensure the schema is applied.
 */
export async function initManifest(
  dataDir?: string
): Promise<PGlite> {
  const db = await getDb(dataDir);
  await ensureSchema(db);
  return db;
}
