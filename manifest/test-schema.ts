import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./init.ts";

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function run() {
  console.log("Manifest schema smoke test\n");

  // 1. Create in-memory PGlite and apply schema
  console.log("1. Schema application");
  const db = await PGlite.create("memory://");
  await applySchema(db);
  console.log("  ✓ Schema applied to fresh PGlite instance");

  // 2. Verify tables exist
  console.log("\n2. Table verification");
  const tables = await db.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  const tableNames = tables.rows.map((r) => r.table_name);
  await assert(tableNames.includes("work_items"), "work_items table exists");
  await assert(tableNames.includes("edges"), "edges table exists");

  // 3. Insert a phase work item
  console.log("\n3. Insert work items");
  await db.exec(`
    INSERT INTO work_items (id, name, kind, state) VALUES
      ('phase:test', 'Test Phase', 'phase', 'planned')
  `);
  await assert(true, "Inserted phase work item");

  // 4. Insert an issue work item with predicted_files
  await db.exec(`
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
      ARRAY['src/foo.ts', 'src/bar.ts'],
      '{"bootstrap_status":"active","needs_human":false}'::jsonb
    )
  `);
  await assert(true, "Inserted issue work item with predicted_files");

  // 5. Insert edges
  console.log("\n4. Insert edges");
  await db.exec(`
    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('sr#100', 'is_part_of', 'phase:test', 'certain')
  `);
  await assert(true, "Inserted is_part_of edge");

  // 6. Query back and verify
  console.log("\n5. Query verification");
  const items = await db.query<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM work_items ORDER BY id`
  );
  await assert(items.rows.length === 2, `Got ${items.rows.length} work items (expected 2)`);

  const edges = await db.query<{ from_id: string; rel: string; to_id: string }>(
    `SELECT from_id, rel, to_id FROM edges`
  );
  await assert(edges.rows.length === 1, `Got ${edges.rows.length} edge (expected 1)`);
  await assert(edges.rows[0].rel === "is_part_of", "Edge rel is 'is_part_of'");

  // 7. Verify predicted_files array and GIN index work
  console.log("\n6. Array + GIN index verification");
  const overlap = await db.query<{ id: string }>(
    `SELECT id FROM work_items WHERE predicted_files && ARRAY['src/foo.ts']`
  );
  await assert(overlap.rows.length === 1, "GIN index array overlap query works");
  await assert(overlap.rows[0].id === "sr#100", "Correct item found via array overlap");

  // 8. Test UNIQUE constraint on edges
  console.log("\n7. Constraint tests");
  try {
    await db.exec(`
      INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
        ('sr#100', 'is_part_of', 'phase:test', 'certain')
    `);
    throw new Error("FAIL: Duplicate edge should have been rejected");
  } catch (e: any) {
    await assert(
      e.message.includes("unique") || e.message.includes("duplicate"),
      "UNIQUE constraint rejects duplicate edge"
    );
  }

  // 9. Test CHECK constraint on kind
  try {
    await db.exec(`
      INSERT INTO work_items (id, name, kind) VALUES
        ('bad#1', 'Bad item', 'invalid_kind')
    `);
    throw new Error("FAIL: Invalid kind should have been rejected");
  } catch (e: any) {
    await assert(
      e.message.includes("check") || e.message.includes("violates"),
      "CHECK constraint rejects invalid kind"
    );
  }

  // 10. Test CHECK constraint on state
  try {
    await db.exec(`
      INSERT INTO work_items (id, name, kind, state) VALUES
        ('bad#2', 'Bad state', 'issue', 'invalid_state')
    `);
    throw new Error("FAIL: Invalid state should have been rejected");
  } catch (e: any) {
    await assert(
      e.message.includes("check") || e.message.includes("violates"),
      "CHECK constraint rejects invalid state"
    );
  }

  // 11. Test CHECK constraint on edge rel
  try {
    await db.exec(`
      INSERT INTO edges (from_id, rel, to_id) VALUES
        ('sr#100', 'invalid_rel', 'phase:test')
    `);
    throw new Error("FAIL: Invalid rel should have been rejected");
  } catch (e: any) {
    await assert(
      e.message.includes("check") || e.message.includes("violates"),
      "CHECK constraint rejects invalid edge rel"
    );
  }

  // 12. Test FK constraint
  try {
    await db.exec(`
      INSERT INTO edges (from_id, rel, to_id) VALUES
        ('nonexistent', 'depends_on', 'phase:test')
    `);
    throw new Error("FAIL: FK violation should have been rejected");
  } catch (e: any) {
    await assert(
      e.message.includes("foreign key") || e.message.includes("violates"),
      "FK constraint rejects nonexistent from_id"
    );
  }

  // 13. Test defaults
  console.log("\n8. Default value tests");
  const defaults = await db.query<{ state: string; meta: any }>(
    `SELECT state, meta FROM work_items WHERE id = 'phase:test'`
  );
  await assert(defaults.rows[0].state === "planned", "Default state is 'planned'");
  await assert(
    JSON.stringify(defaults.rows[0].meta) === "{}",
    "Default meta is empty object"
  );

  console.log("\n✅ All tests passed!\n");
  await db.close();
}

run().catch((e) => {
  console.error("\n❌ Test failed:", e.message);
  process.exit(1);
});
