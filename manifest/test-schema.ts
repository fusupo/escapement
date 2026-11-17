import Database from "better-sqlite3";
import { applySchema } from "./init.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

function run() {
  console.log("Manifest schema smoke test\n");

  // 1. Create in-memory SQLite and apply schema
  console.log("1. Schema application");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  console.log("  \u2713 Schema applied to fresh SQLite instance");

  // 2. Verify tables exist
  console.log("\n2. Table verification");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all() as { name: string }[];
  const tableNames = tables.map((r) => r.name);
  assert(tableNames.includes("work_items"), "work_items table exists");
  assert(tableNames.includes("edges"), "edges table exists");

  // 3. Insert a phase work item
  console.log("\n3. Insert work items");
  db.exec(`
    INSERT INTO work_items (id, name, kind, state) VALUES
      ('phase:test', 'Test Phase', 'phase', 'planned')
  `);
  assert(true, "Inserted phase work item");

  // 4. Insert an issue work item with predicted_files
  db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url, predicted_files, meta
    ) VALUES (
      'sr#100',
      'Test issue',
      'issue',
      'planned',
      'systema-relica',
      100,
      'https://github.com/example/repo/issues/100',
      '["src/foo.ts", "src/bar.ts"]',
      '{"bootstrap_status":"active","needs_human":false}'
    )
  `);
  assert(true, "Inserted issue work item with predicted_files");

  // 5. Insert edges
  console.log("\n4. Insert edges");
  db.exec(`
    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('sr#100', 'is_part_of', 'phase:test', 'certain')
  `);
  assert(true, "Inserted is_part_of edge");

  // 6. Query back and verify
  console.log("\n5. Query verification");
  const items = db.prepare(
    "SELECT id, name, kind FROM work_items ORDER BY id"
  ).all() as { id: string; name: string; kind: string }[];
  assert(items.length === 2, `Got ${items.length} work items (expected 2)`);

  const edges = db.prepare(
    "SELECT from_id, rel, to_id FROM edges"
  ).all() as { from_id: string; rel: string; to_id: string }[];
  assert(edges.length === 1, `Got ${edges.length} edge (expected 1)`);
  assert(edges[0].rel === "is_part_of", "Edge rel is 'is_part_of'");

  // 7. Verify predicted_files array query using json_each
  console.log("\n6. JSON array query verification");
  const overlap = db.prepare(
    `SELECT id FROM work_items WHERE EXISTS (
       SELECT 1 FROM json_each(predicted_files) WHERE value = 'src/foo.ts'
     )`
  ).all() as { id: string }[];
  assert(overlap.length === 1, "json_each array query works");
  assert(overlap[0].id === "sr#100", "Correct item found via json_each query");

  // 8. Test UNIQUE constraint on edges
  console.log("\n7. Constraint tests");
  try {
    db.exec(`
      INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
        ('sr#100', 'is_part_of', 'phase:test', 'certain')
    `);
    throw new Error("FAIL: Duplicate edge should have been rejected");
  } catch (e: any) {
    assert(
      e.message.includes("UNIQUE") || e.message.includes("unique"),
      "UNIQUE constraint rejects duplicate edge"
    );
  }

  // 9. Test CHECK constraint on kind
  try {
    db.exec(`
      INSERT INTO work_items (id, name, kind) VALUES
        ('bad#1', 'Bad item', 'invalid_kind')
    `);
    throw new Error("FAIL: Invalid kind should have been rejected");
  } catch (e: any) {
    assert(
      e.message.includes("CHECK") || e.message.includes("constraint"),
      "CHECK constraint rejects invalid kind"
    );
  }

  // 10. Test CHECK constraint on state
  try {
    db.exec(`
      INSERT INTO work_items (id, name, kind, state) VALUES
        ('bad#2', 'Bad state', 'issue', 'invalid_state')
    `);
    throw new Error("FAIL: Invalid state should have been rejected");
  } catch (e: any) {
    assert(
      e.message.includes("CHECK") || e.message.includes("constraint"),
      "CHECK constraint rejects invalid state"
    );
  }

  // 11. Test CHECK constraint on edge rel
  try {
    db.exec(`
      INSERT INTO edges (from_id, rel, to_id) VALUES
        ('sr#100', 'invalid_rel', 'phase:test')
    `);
    throw new Error("FAIL: Invalid rel should have been rejected");
  } catch (e: any) {
    assert(
      e.message.includes("CHECK") || e.message.includes("constraint"),
      "CHECK constraint rejects invalid edge rel"
    );
  }

  // 12. Test FK constraint
  try {
    db.exec(`
      INSERT INTO edges (from_id, rel, to_id) VALUES
        ('nonexistent', 'depends_on', 'phase:test')
    `);
    throw new Error("FAIL: FK violation should have been rejected");
  } catch (e: any) {
    assert(
      e.message.includes("FOREIGN KEY") || e.message.includes("foreign"),
      "FK constraint rejects nonexistent from_id"
    );
  }

  // 13. Test defaults
  console.log("\n8. Default value tests");
  const defaults = db.prepare(
    "SELECT state, meta FROM work_items WHERE id = 'phase:test'"
  ).get() as { state: string; meta: string };
  assert(defaults.state === "planned", "Default state is 'planned'");
  assert(defaults.meta === "{}", "Default meta is empty object");

  console.log("\n\u2705 All tests passed!\n");
  db.close();
}

try {
  run();
} catch (e: any) {
  console.error("\n\u274c Test failed:", e.message);
  process.exit(1);
}
