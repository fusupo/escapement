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

import Database from "better-sqlite3";
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

function parseJsonArray(v: unknown): string[] {
  if (typeof v === "string") return JSON.parse(v);
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * Frontier query: planned issues whose dependencies are all done.
 */
function queryFrontier(db: Database.Database): string[] {
  const result = db.prepare(`
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
  `).all() as { id: string }[];
  return result.map((r) => r.id);
}

function run() {
  console.log("Manifest seed tests\n");

  // Setup: in-memory SQLite with schema
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);

  // -----------------------------------------------------------------------
  // 1. Run seed and verify counts
  // -----------------------------------------------------------------------
  console.log("1. Seed execution and item counts");
  const result = seed(db);
  assert(result.itemsInserted === 13, `Inserted ${result.itemsInserted} items (expected 13: 1 phase + 3 tracks + 9 issues)`);
  assert(result.edgesInserted === 22, `Inserted ${result.edgesInserted} edges (expected 22: 10 deps + 12 hierarchy)`);

  // Verify total counts from DB
  const itemCount = db.prepare("SELECT count(*) AS count FROM work_items").get() as { count: number };
  assert(itemCount.count === 13, `DB has 13 work items`);

  const edgeCount = db.prepare("SELECT count(*) AS count FROM edges").get() as { count: number };
  assert(edgeCount.count === 22, `DB has 22 edges`);

  // -----------------------------------------------------------------------
  // 2. Verify work item kinds
  // -----------------------------------------------------------------------
  console.log("\n2. Work item kinds");
  const phases = db.prepare("SELECT count(*) AS count FROM work_items WHERE kind = 'phase'").get() as { count: number };
  assert(phases.count === 1, `1 phase entity`);

  const trackCount = db.prepare("SELECT count(*) AS count FROM work_items WHERE kind = 'track'").get() as { count: number };
  assert(trackCount.count === 3, `3 track entities`);

  const issueCount = db.prepare("SELECT count(*) AS count FROM work_items WHERE kind = 'issue'").get() as { count: number };
  assert(issueCount.count === 9, `9 issue entities`);

  // -----------------------------------------------------------------------
  // 3. Verify m#1 is done
  // -----------------------------------------------------------------------
  console.log("\n3. State verification");
  const m1 = db.prepare("SELECT state FROM work_items WHERE id = 'm#1'").get() as { state: string };
  assert(m1.state === "done", `m#1 state is 'done'`);

  const m4 = db.prepare("SELECT state FROM work_items WHERE id = 'm#4'").get() as { state: string };
  assert(m4.state === "in_progress", `m#4 state is 'in_progress'`);

  // -----------------------------------------------------------------------
  // 4. Frontier query: initial dispatchable set
  // -----------------------------------------------------------------------
  console.log("\n4. Frontier query (initial)");
  const frontier1 = queryFrontier(db);
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
  db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#2', 'm#3')`);

  const frontier2 = queryFrontier(db);
  assert(frontier2.includes("m#5"), `m#5 unblocked after m#2 and m#3 done`);
  assert(!frontier2.includes("m#6"), `m#6 still blocked (needs m#5)`);
  assert(!frontier2.includes("m#9"), `m#9 still blocked (needs m#6, m#7)`);

  // -----------------------------------------------------------------------
  // 6. Full chain: mark through to m#9
  // -----------------------------------------------------------------------
  console.log("\n6. Full dependency chain");
  db.exec(`UPDATE work_items SET state = 'done' WHERE id = 'm#5'`);
  const frontier3 = queryFrontier(db);
  assert(frontier3.includes("m#6"), `m#6 unblocked after m#5 done`);
  assert(frontier3.includes("m#7"), `m#7 unblocked after m#5 done`);
  assert(frontier3.includes("m#8"), `m#8 unblocked after m#5 done`);
  assert(!frontier3.includes("m#9"), `m#9 still blocked (needs m#6 and m#7)`);

  db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#6', 'm#7')`);
  const frontier4 = queryFrontier(db);
  assert(frontier4.includes("m#9"), `m#9 unblocked after m#6 and m#7 done`);
  assert(frontier4.includes("m#8"), `m#8 still in frontier (independent)`);

  // -----------------------------------------------------------------------
  // 7. Hierarchy edges
  // -----------------------------------------------------------------------
  console.log("\n7. Hierarchy edges");
  const trackToPhase = db.prepare(`
    SELECT count(*) AS count FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'phase:manifest'
    AND from_id LIKE 'track:%'
  `).get() as { count: number };
  assert(trackToPhase.count === 3, `3 tracks belong to phase:manifest`);

  const foundationItems = db.prepare(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:foundation'
    ORDER BY from_id
  `).all() as { from_id: string }[];
  const foundationIds = foundationItems.map((r) => r.from_id);
  assert(
    foundationIds.length === 4 &&
      foundationIds.includes("m#1") &&
      foundationIds.includes("m#2") &&
      foundationIds.includes("m#3") &&
      foundationIds.includes("m#4"),
    `Foundation track has m#1-m#4`
  );

  const planningItems = db.prepare(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:planning'
    ORDER BY from_id
  `).all() as { from_id: string }[];
  assert(planningItems.length === 4, `Planning track has 4 items (m#5-m#8)`);

  const dispatchItems = db.prepare(`
    SELECT from_id FROM edges
    WHERE rel = 'is_part_of' AND to_id = 'track:dispatch'
  `).all() as { from_id: string }[];
  assert(
    dispatchItems.length === 1 && dispatchItems[0].from_id === "m#9",
    `Dispatch track has m#9`
  );

  // -----------------------------------------------------------------------
  // 8. Idempotency: running seed again should not duplicate
  // -----------------------------------------------------------------------
  console.log("\n8. Idempotency");
  db.exec(`UPDATE work_items SET state = 'done' WHERE id IN ('m#6', 'm#7', 'm#8')`);
  const result2 = seed(db);
  assert(result2.itemsInserted === 0, `Re-seed inserted 0 items (idempotent)`);
  assert(result2.edgesInserted === 0, `Re-seed inserted 0 edges (idempotent)`);

  const finalItemCount = db.prepare("SELECT count(*) AS count FROM work_items").get() as { count: number };
  assert(finalItemCount.count === 13, `Still 13 items after re-seed`);

  // -----------------------------------------------------------------------
  // 9. Predicted files populated
  // -----------------------------------------------------------------------
  console.log("\n9. Predicted files");
  const m1files = db.prepare(
    "SELECT predicted_files FROM work_items WHERE id = 'm#1'"
  ).get() as { predicted_files: string };
  const m1filesParsed = parseJsonArray(m1files.predicted_files);
  assert(m1filesParsed.length === 5, `m#1 has 5 predicted files`);
  assert(
    m1filesParsed.includes("manifest/schema.sql"),
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

  db.close();
}

try {
  run();
} catch (e: any) {
  console.error("\nTest crashed:", e.message);
  process.exit(1);
}
