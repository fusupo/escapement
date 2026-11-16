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
  version: 2,
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
    assert(tables(db).join(",") === "edges,work_items", "fresh db has work_items and edges");

    const again = migrate(db);
    assert(again.from === again.to && again.to === MIGRATIONS.length, "second run is a no-op");
    db.close();
  }

  {
    const db = legacyV1Db();
    const r = migrate(db);
    assert(r.from === 0 && r.to === 1, "unversioned v1 db is adopted as version 1");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM work_items").get() as { n: number }).n;
    assert(count === 2, "adopted db keeps its work items");
    db.close();
  }

  {
    const db = legacyV1Db();
    const r = migrate(db, [...MIGRATIONS, notes]);
    assert(r.from === 0 && r.to === 2, "pending migration 2 runs on an adopted v1 db");
    assert(tables(db).includes("notes"), "migration 2 created its table");
    const edges = (db.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n;
    assert(edges === 1, "existing edges survive the upgrade");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    db.prepare("INSERT INTO work_items (id, name, kind) VALUES ('a', 'Item A', 'issue')").run();
    const r = migrate(db, [...MIGRATIONS, notes]);
    assert(r.from === 1 && r.to === 2, "versioned v1 db upgrades in place to 2");
    db.close();
  }

  {
    const db = new Database(":memory:");
    migrate(db);
    const broken: Migration = {
      version: 2,
      name: "broken",
      up: (d) => {
        d.exec("CREATE TABLE half_done (id INTEGER)");
        throw new Error("boom");
      },
    };
    throws(() => migrate(db, [...MIGRATIONS, broken]), /boom/, "failing migration raises");
    assert(schemaVersion(db) === 1, "failed migration leaves user_version unchanged");
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
