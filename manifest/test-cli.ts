import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./init.ts";

/**
 * Smoke tests for manifest CLI queries.
 *
 * Instead of spawning the CLI as a subprocess, we test the core SQL queries
 * directly against an in-memory PGlite instance with the example seed data
 * from V2 design doc Section 15.
 */

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function seedTestData(db: PGlite) {
  await db.exec(`
    INSERT INTO work_items (id, name, kind, state) VALUES
      ('phase:test_infra', 'Phase 1: Test Infrastructure', 'phase', 'planned'),
      ('track:phase1:api', 'API Layer', 'track', 'planned');

    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url, predicted_files, meta
    ) VALUES
      (
        'test#1',
        'Build data model',
        'issue',
        'done',
        'test-repo',
        1,
        'https://github.com/test/repo/issues/1',
        ARRAY['src/model.ts'],
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'test#2',
        'Build API endpoints',
        'issue',
        'planned',
        'test-repo',
        2,
        'https://github.com/test/repo/issues/2',
        ARRAY['src/api.ts', 'src/model.ts'],
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'test#3',
        'Write integration tests',
        'issue',
        'planned',
        'test-repo',
        3,
        'https://github.com/test/repo/issues/3',
        ARRAY['tests/api.test.ts'],
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'test#4',
        'Needs human review',
        'issue',
        'planned',
        'test-repo',
        4,
        'https://github.com/test/repo/issues/4',
        '{}',
        '{"needs_human":true}'::jsonb
      );

    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('track:phase1:api', 'is_part_of', 'phase:test_infra', 'certain'),
      ('test#1', 'is_part_of', 'track:phase1:api', 'certain'),
      ('test#2', 'is_part_of', 'track:phase1:api', 'certain'),
      ('test#2', 'depends_on', 'test#1', 'certain'),
      ('test#3', 'is_part_of', 'track:phase1:api', 'certain'),
      ('test#3', 'depends_on', 'test#2', 'certain');
  `);
}

async function run() {
  console.log("Manifest CLI query smoke tests\n");

  const db = await PGlite.create("memory://");
  await applySchema(db);
  await seedTestData(db);
  console.log("  ✓ Test data seeded\n");

  // ── Test 1: Frontier query ───────────────────────────────────────
  console.log("1. Frontier query");

  const frontier = await db.query<{ id: string; name: string }>(`
    SELECT w.id, w.name
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE((w.meta->>'needs_human')::boolean, false) = false
      AND NOT EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
    ORDER BY w.id
  `);

  const frontierIds = frontier.rows.map((r) => r.id);
  // test#1 is done, test#2 depends on test#1 (done) so it IS dispatchable
  // test#3 depends on test#2 (planned) so it is NOT dispatchable
  // test#4 needs_human=true so it is NOT dispatchable
  await assert(frontierIds.includes("test#2"), "test#2 is on frontier (dep test#1 is done)");
  await assert(!frontierIds.includes("test#1"), "test#1 excluded (already done)");
  await assert(!frontierIds.includes("test#3"), "test#3 excluded (dep test#2 not done)");
  await assert(!frontierIds.includes("test#4"), "test#4 excluded (needs_human=true)");
  await assert(frontierIds.length === 1, "Exactly 1 frontier item");

  // ── Test 2: Mark done and recompute frontier ─────────────────────
  console.log("\n2. Mark done + frontier recompute");

  await db.query(
    "UPDATE work_items SET state = 'done', updated_at = now() WHERE id = $1",
    ["test#2"]
  );

  const frontier2 = await db.query<{ id: string }>(`
    SELECT w.id
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE((w.meta->>'needs_human')::boolean, false) = false
      AND NOT EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
    ORDER BY w.id
  `);

  const frontier2Ids = frontier2.rows.map((r) => r.id);
  await assert(frontier2Ids.includes("test#3"), "test#3 now on frontier after test#2 done");
  await assert(!frontier2Ids.includes("test#2"), "test#2 no longer on frontier (now done)");

  // ── Test 3: Hierarchical status rollup ───────────────────────────
  console.log("\n3. Status rollup");

  const rollup = await db.query<{
    name: string;
    total_items: string;
    done_items: string;
  }>(`
    WITH RECURSIVE tree AS (
      SELECT
        parent.id AS root_id,
        child.id  AS child_id
      FROM work_items parent
      JOIN edges e ON e.to_id = parent.id AND e.rel = 'is_part_of'
      JOIN work_items child ON child.id = e.from_id
      WHERE parent.kind IN ('phase', 'track')

      UNION ALL

      SELECT
        tree.root_id,
        child.id
      FROM tree
      JOIN edges e ON e.to_id = tree.child_id AND e.rel = 'is_part_of'
      JOIN work_items child ON child.id = e.from_id
    )
    SELECT
      root.name,
      COUNT(*) FILTER (WHERE leaf.kind IN ('issue', 'capability'))::text AS total_items,
      COUNT(*) FILTER (
        WHERE leaf.kind IN ('issue', 'capability') AND leaf.state = 'done'
      )::text AS done_items
    FROM tree
    JOIN work_items root ON root.id = tree.root_id
    JOIN work_items leaf ON leaf.id = tree.child_id
    GROUP BY root.id, root.name
    ORDER BY root.name
  `);

  // Track has 3 direct issues (test#1, test#2, test#3); test#4 not part of track
  const track = rollup.rows.find((r) => r.name === "API Layer");
  await assert(track !== undefined, "API Layer track found in rollup");
  await assert(track!.total_items === "3", "Track has 3 total issue items");
  await assert(track!.done_items === "2", "Track has 2 done items (test#1, test#2)");

  // Phase rolls up through track, so it should see the same leaf items
  const phase = rollup.rows.find((r) => r.name === "Phase 1: Test Infrastructure");
  await assert(phase !== undefined, "Phase found in rollup");
  await assert(phase!.total_items === "3", "Phase has 3 total items (via track)");
  await assert(phase!.done_items === "2", "Phase has 2 done items (via track)");

  // ── Test 4: Item not found handling ──────────────────────────────
  console.log("\n4. Edge cases");

  const missing = await db.query<{ id: string }>(
    "SELECT id FROM work_items WHERE id = $1",
    ["nonexistent"]
  );
  await assert(missing.rows.length === 0, "Nonexistent item returns empty result");

  const alreadyDone = await db.query<{ state: string }>(
    "SELECT state FROM work_items WHERE id = $1",
    ["test#1"]
  );
  await assert(alreadyDone.rows[0].state === "done", "test#1 state is 'done'");

  // ── Done ─────────────────────────────────────────────────────────
  await db.close();
  console.log("\nAll tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
