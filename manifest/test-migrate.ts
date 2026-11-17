import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS, migrate, schemaVersion, type Migration } from "./migrations.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function throws(fn: () => unknown, pattern: RegExp, msg: string) {
  try {
    fn();
  } catch (err) {
    assert(pattern.test(String(err)), `${msg} (${String(err)})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

function tables(db: DatabaseType): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** A database as created before versioning: schema.sql applied, user_version 0. */
function legacyV1Db(): DatabaseType {
  const db = new Database(":memory:");
  db.exec(readFileSync(resolve(__dirname, "schema.sql"), "utf-8"));
  db.prepare("INSERT INTO work_items (id, name, kind) VALUES ('a', 'Item A', 'issue')").run();
  db.prepare("INSERT INTO work_items (id, name, kind) VALUES ('b', 'Item B', 'issue')").run();
  db.prepare("INSERT INTO edges (from_id, rel, to_id) VALUES ('b', 'depends_on', 'a')").run();
  return db;
}

const notes: Migration = {
  version: MIGRATIONS.length + 1,
  name: "test notes table",
  up: (db) => db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"),
};

function run() {
  console.log("Schema migrations\n");

  {
    const db = new Database(":memory:");
    const r = migrate(db);
    assert(r.from === 0 && r.to === MIGRATIONS.length, `fresh db migrates 0 -> ${MIGRATIONS.length}`);
    assert(schemaVersion(db) === MIGRATIONS.length, "user_version set to latest");
    assert(
      tables(db).join(",") ===
        "edges,factory_attempts,factory_authorizations,factory_events,factory_locks,factory_runs,work_items",
      "fresh db has the manifest and factory tables",
    );

    const again = migrate(db);
    assert(again.from === again.to && again.to === MIGRATIONS.length, "second run is a no-op");
    db.close();
  }

  {
    const db = legacyV1Db();
    const r = migrate(db);
    assert(r.from === 0 && r.to === MIGRATIONS.length, "unversioned v1 db is adopted as 1 and migrated to latest");
    assert(tables(db).includes("factory_runs"), "adopted db gains the factory tables");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
    assert(count === 2, "adopted db keeps its work items");
    db.close();
  }

  {
    const db = legacyV1Db();
    const r = migrate(db, [...MIGRATIONS, notes]);
    assert(r.from === 0 && r.to === notes.version, "pending migrations run on an adopted v1 db");
    assert(tables(db).includes("notes"), "the extra migration created its table");
    const edges = (db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n;
    assert(edges === 1, "existing edges survive the upgrade");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO work_items (id, name, kind) VALUES ('a', 'Item A', 'issue')").run();
    const r = migrate(db, [...MIGRATIONS, notes]);
    assert(r.from === MIGRATIONS.length && r.to === notes.version, "versioned db upgrades in place");
    db.close();
  }

  {
    // A database at version 1 (manifest only) gains the factory tables.
    const db = legacyV1Db();
    migrate(db, MIGRATIONS.slice(0, 1));
    assert(schemaVersion(db) === 1, "db pinned at version 1");
    const r = migrate(db);
    assert(r.from === 1 && r.to === 2, "version 1 db upgrades to 2");
    assert(tables(db).includes("factory_locks"), "migration 2 adds factory_locks");
    const items = (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
    assert(items === 2, "work items survive migration 2");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    const insertRun = (id: string, state: string) =>
      db
        .prepare(
          `INSERT INTO factory_runs (run_id, work_item, repo, worktree_path, branch, target_ref,
             artifact_dir, state, started_at) VALUES (?, 'w', 'o/r', '/wt', 'b', 'develop', '/a', ?, 'now')`,
        )
        .run(id, state);
    insertRun("r1", "planned");
    throws(() => insertRun("r2", "bogus"), /CHECK constraint/, "run state CHECK rejects unknown states");
    const insertAuth = (digest: string, status: string) =>
      db
        .prepare(
          `INSERT INTO factory_authorizations (run_id, contract_digest, baseline_json, authorizes_json,
             status, approved_at) VALUES ('r1', ?, '{}', '[]', ?, 'now')`,
        )
        .run(digest, status);
    insertAuth("d1", "active");
    throws(() => insertAuth("d2", "active"), /UNIQUE constraint/, "only one active authorization per run");
    insertAuth("d3", "superseded");
    const insertAttempt = (n: number) =>
      db
        .prepare(
          `INSERT INTO factory_attempts (run_id, attempt, status, head_sha, contract_digest,
             policy_version, started_at) VALUES ('r1', ?, 'checks_running', 'abc', 'd1', 'p', 'now')`,
        )
        .run(n);
    insertAttempt(1);
    throws(() => insertAttempt(1), /UNIQUE constraint|PRIMARY KEY/, "attempt numbers are unique per run");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    const broken: Migration = {
      version: MIGRATIONS.length + 1,
      name: "broken",
      up: (d) => {
        d.exec("CREATE TABLE half_done (id INTEGER)");
        throw new Error("boom");
      },
    };
    throws(() => migrate(db, [...MIGRATIONS, broken]), /boom/, "failing migration raises");
    assert(schemaVersion(db) === MIGRATIONS.length, "failed migration leaves user_version unchanged");
    assert(!tables(db).includes("half_done"), "failed migration is rolled back");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    db.pragma(`user_version = ${MIGRATIONS.length + 5}`);
    throws(() => migrate(db), /newer than this plugin supports/, "newer db is refused");
    db.close();
  }

  {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE work_items (id TEXT)");
    throws(() => migrate(db), /no edges table/, "partial unversioned db is refused");
    db.close();
  }

  {
    const db = new Database(":memory:");
    throws(() => migrate(db, [notes]), /out of order/, "gap in migration versions is rejected");
    db.close();
  }

  console.log("\nAll migration tests passed.");
}

run();
