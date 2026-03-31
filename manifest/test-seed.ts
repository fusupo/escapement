/**
 * test-seed.ts -- Verify the manifest seed produces a correct dependency graph.
 *
 * Tests:
 * 1. Correct number of work items and edges
 * 2. Frontier query returns {m#2, m#3, m#4} (m#1 is done)
 * 3. Marking m#2 and m#3 done unblocks m#5
 * 4. Hierarchy edges connect issues to tracks and tracks to phase
 * 5. Idempotency: running seed twice does not duplicate data
 */

import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./init.ts";
import { seed } from "./seed.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  OK: ${msg}`);
    passed++;
  }
}

/**
 * Frontier query: planned issues whose dependencies are all done.
 */
async function queryFrontier(db: PGlite): Promise<string[]> {
  const result = await db.query<{ id: string }>(`
    SELECT wi.id
    FROM work_items wi
    WHERE wi.state = 'planned'
      AND wi.kind = 'issue'
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.from_id = wi.id
          AND e.rel = 'depends_on'
          AND dep.state != 'done'
      )
    ORDER BY wi.id
  `);
  return result.rows.map((r) => r.id);
}

async function run() {
  console.log("Manifest seed tests\n");

  // Setup: in-memory PGlite with schema
  const db = await PGlite.create("memory://");
  await applySchema(db);

  // -----------------------------------------------------------------------
  // 1. Run seed and verify counts
  // -----------------------------------------------------------------------
  console.log("1. Seed execution and item counts");
  const result = await seed(db);
  assert(result.itemsInserted === 13, `Inserted ${result.itemsInserted} items (expected 13: 1 phase + 3 tracks + 9 issues)`);
  assert(result.edgesInserted === 22, `Inserted ${result.edgesInserted} edges (expected 22: 10 deps + 12 hierarchy)`);

  // Verify total counts from DB
  const itemCount = await db.query<{ count: string }>(`SELECT count(*) AS count FROM work_items`);
  assert(parseInt(itemCount.rows[0].count) === 13, `DB has 13 work items`);

  const edgeCount = await db.query<{ count: string }>(`SELECT count(*) AS count FROM edges`);
  assert(parseInt(edgeCount.rows[0].count) === 22, `DB has 22 edges`);

  // -----------------------------------------------------------------------
  // 2. Verify work item kinds
  // -----------------------------------------------------------------------
  console.log("\n2. Work item kinds");
  const phases = await db.query<{ count: string }>(`SELECT count(*) AS count FROM work_items WHERE kind = 'phase'`);
  assert(parseInt(phases.rows[0].count) === 1, `1 phase entity`);

  const trackCount = await db.query<{ count: string }>(`SELECT count(*) AS count FROM work_items WHERE kind = 'track'`);
  assert(parseInt(trackCount.rows[0].count) === 3, `3 track entities`);

  const issueCount = await db.query<{ count: string }>(`SELECT count(*) AS count FROM work_items WHERE kind = 'issue'`);
  assert(parseInt(issueCount.rows[0].count) === 9, `9 issue entities`);

  // -----------------------------------------------------------------------
  // 3. Verify m#1 is done
  // -----------------------------------------------------------------------
  console.log("\n3. State verification");
  const m1 = await db.query<{ state: string }>(`SELECT state FROM work_items WHERE id = 'm#1'`);
  assert(m1.rows[0].state === "done", `m#1 state is 'done'`);

  const m4 = await db.query<{ state: string }>(`SELECT state FROM work_items WHERE id = 'm#4'`);
  assert(m4.rows[0].state === "in_progress", `m#4 state is 'in_progress'`);

  // -----------------------------------------------------------------------
  // 4. Frontier query: initial dispatchable set
  // -----------------------------------------------------------------------
  console.log("\n4. Frontier query (initial)");
  const frontier1 = await queryFrontier(db);
  assert(
    frontier1.length === 2,
    `Frontier has 2 items (expected: m#2, m#3 -- m#4 is in_progress so excluded)`
  );
  assert(frontier1.includes("m#2"), `m#2 is in frontier`);
  assert(frontier1.includes("m#3"), `m#3 is in frontier`);
  assert(!frontier1.includes("m#1"), `m#1 (done) not in frontier`);
  assert(!frontier1.includes("m#4"), `m#4 (in_progress) not in frontier`);
  assert(!frontier1.includes("m#5"), `m#5 (blocked) not in frontier`);

  // -----------------------------------------------------------------------
  // 5. Mark m#2 and m#3 done -> m#5 becomes dispatchable
  // -----------------------------------------------------------------------
  console.log("\n5. Unblocking behavior");
  await db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#2', 'm#3')`);

  const frontier2 = await queryFrontier(db);
  assert(frontier2.includes("m#5"), `m#5 unblocked after m#2 and m#3 done`);
  assert(!frontier2.includes("m#6"), `m#6 still blocked (needs m#5)`);
  assert(!frontier2.includes("m#9"), `m#9 still blocked (needs m#6, m#7)`);

  // -----------------------------------------------------------------------
  // 6. Full chain: mark through to m#9
  // -----------------------------------------------------------------------
  console.log("\n6. Full dependency chain");
  await db.exec(`UPDATE work_items SET state = 'done' WHERE id = 'm#5'`);
  const frontier3 = await queryFrontier(db);
  assert(frontier3.includes("m#6"), `m#6 unblocked after m#5 done`);
  assert(frontier3.includes("m#7"), `m#7 unblocked after m#5 done`);
  assert(frontier3.includes("m#8"), `m#8 unblocked after m#5 done`);
  assert(!frontier3.includes("m#9"), `m#9 still blocked (needs m#6 and m#7)`);

  await db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#6', 'm#7')`);
  const frontier4 = await queryFrontier(db);
  assert(frontier4.includes("m#9"), `m#9 unblocked after m#6 and m#7 done`);
  assert(frontier4.includes("m#8"), `m#8 still in frontier (independent)`);

  // -----------------------------------------------------------------------
  // 7. Hierarchy edges
  // -----------------------------------------------------------------------
  console.log("\n7. Hierarchy edges");
  const trackToPhase = await db.query<{ count: string }>(`
    SELECT count(*) AS count FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'phase:manifest'
    AND from_id LIKE 'track:%'
  `);
  assert(parseInt(trackToPhase.rows[0].count) === 3, `3 tracks belong to phase:manifest`);

  const foundationItems = await db.query<{ from_id: string }>(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:foundation'
    ORDER BY from_id
  `);
  const foundationIds = foundationItems.rows.map((r) => r.from_id);
  assert(
    foundationIds.length === 4 &&
      foundationIds.includes("m#1") &&
      foundationIds.includes("m#2") &&
      foundationIds.includes("m#3") &&
      foundationIds.includes("m#4"),
    `Foundation track has m#1-m#4`
  );

  const planningItems = await db.query<{ from_id: string }>(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:planning'
    ORDER BY from_id
  `);
  assert(planningItems.rows.length === 4, `Planning track has 4 items (m#5-m#8)`);

  const dispatchItems = await db.query<{ from_id: string }>(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:dispatch'
  `);
  assert(
    dispatchItems.rows.length === 1 && dispatchItems.rows[0].from_id === "m#9",
    `Dispatch track has m#9`
  );

  // -----------------------------------------------------------------------
  // 8. Idempotency: running seed again should not duplicate
  // -----------------------------------------------------------------------
  console.log("\n8. Idempotency");
  // Reset states for clean re-seed test
  await db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#6', 'm#7', 'm#8')`);
  const result2 = await seed(db);
  assert(result2.itemsInserted === 0, `Re-seed inserted 0 items (idempotent)`);
  assert(result2.edgesInserted === 0, `Re-seed inserted 0 edges (idempotent)`);

  const finalItemCount = await db.query<{ count: string }>(`SELECT count(*) AS count FROM work_items`);
  assert(parseInt(finalItemCount.rows[0].count) === 13, `Still 13 items after re-seed`);

  // -----------------------------------------------------------------------
  // 9. Predicted files populated
  // -----------------------------------------------------------------------
  console.log("\n9. Predicted files");
  const m1files = await db.query<{ predicted_files: string[] }>(
    `SELECT predicted_files FROM work_items WHERE id = 'm#1'`
  );
  assert(m1files.rows[0].predicted_files.length === 5, `m#1 has 5 predicted files`);
  assert(
    m1files.rows[0].predicted_files.includes("manifest/schema.sql"),
    `m#1 predicted files include manifest/schema.sql`
  );

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nSome tests failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll tests passed.`);
  }

  await db.close();
}

run().catch((e) => {
  console.error("\nTest crashed:", e.message);
  process.exit(1);
});
