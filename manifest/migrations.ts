import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseType) => void;
};

/**
 * Ordered schema migrations. The database records the last one applied in
 * PRAGMA user_version.
 *
 * Never edit a migration that has shipped (schema.sql is migration 1,
 * migrations/002-factory.sql is migration 2 and migrations/003-fix-loop.sql
 * is migration 3; all are frozen once released); add a new one with the
 * next version number instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial work_items and edges",
    up: (db) => db.exec(readFileSync(resolve(__dirname, "schema.sql"), "utf-8")),
  },
  {
    version: 2,
    name: "factory runs, authorizations, attempts, events and locks",
    up: (db) => db.exec(readFileSync(resolve(__dirname, "migrations", "002-factory.sql"), "utf-8")),
  },
  {
    version: 3,
    name: "attempt error cause, for the fix loop",
    up: (db) => db.exec(readFileSync(resolve(__dirname, "migrations", "003-fix-loop.sql"), "utf-8")),
  },
];

export function schemaVersion(db: DatabaseType): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function hasTable(db: DatabaseType, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function checkOrder(migrations: Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `manifest: migration list is out of order: expected version ${i + 1}, found ${m.version} (${m.name})`,
      );
    }
  });
}

/**
 * Bring the database up to the latest schema version.
 *
 * - A fresh database gets every migration.
 * - A database created before versioning (user_version 0 but work_items
 *   present) already has the migration 1 schema, so it is marked as
 *   version 1 and only later migrations run.
 * - A database newer than this code knows about is refused untouched.
 *
 * All pending migrations run in one IMMEDIATE transaction, so concurrent CLI
 * runs serialize on the write lock and a failure leaves the database at its
 * previous version. The version is re-read after the lock is taken.
 */
export function migrate(
  db: DatabaseType,
  migrations: Migration[] = MIGRATIONS,
): { from: number; to: number } {
  checkOrder(migrations);
  const latest = migrations.length;

  // Fast path: up to date, so no write lock is needed.
  const current = schemaVersion(db);
  if (current === latest) return { from: current, to: current };

  const run = db.transaction(() => {
    const from = schemaVersion(db);
    if (from > latest) {
      throw new Error(
        `manifest: database schema version ${from} is newer than this plugin supports (${latest}). Update the plugin.`,
      );
    }

    let version = from;
    if (version === 0 && hasTable(db, "work_items")) {
      if (!hasTable(db, "edges")) {
        throw new Error(
          "manifest: unversioned database has work_items but no edges table; refusing to adopt it.",
        );
      }
      version = 1;
      db.pragma("user_version = 1");
    }

    for (const m of migrations) {
      if (m.version <= version) continue;
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
      version = m.version;
    }
    return { from, to: version };
  });

  return run.immediate();
}
