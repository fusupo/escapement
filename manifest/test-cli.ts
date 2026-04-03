import Database from "better-sqlite3";
import { applySchema } from "./init.ts";

/**
 * Smoke tests for manifest CLI queries.
 *
 * Instead of spawning the CLI as a subprocess, we test the core SQL queries
 * directly against an in-memory SQLite instance with the example seed data
 * from V2 design doc Section 15.
 */

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

function seedTestData(db: Database.Database) {
  db.exec(`
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
        '["src/model.ts"]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'test#2',
        'Build API endpoints',
        'issue',
        'planned',
        'test-repo',
        2,
        'https://github.com/test/repo/issues/2',
        '["src/api.ts", "src/model.ts"]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'test#3',
        'Write integration tests',
        'issue',
        'planned',
        'test-repo',
        3,
        'https://github.com/test/repo/issues/3',
        '["tests/api.test.ts"]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'test#4',
        'Needs human review',
        'issue',
        'planned',
        'test-repo',
        4,
        'https://github.com/test/repo/issues/4',
        '[]',
        '{"needs_human":true}'
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

function run() {
  console.log("Manifest CLI query smoke tests\n");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedTestData(db);
  console.log("  \u2713 Test data seeded\n");

  // ── Test 1: Frontier query ───────────────────────────────────────
  console.log("1. Frontier query");

  const frontier = db.prepare(`
    SELECT w.id, w.name
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
      AND NOT EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
    ORDER BY w.id
  `).all() as { id: string; name: string }[];

  const frontierIds = frontier.map((r) => r.id);
  assert(frontierIds.includes("test#2"), "test#2 is on frontier (dep test#1 is done)");
  assert(!frontierIds.includes("test#1"), "test#1 excluded (already done)");
  assert(!frontierIds.includes("test#3"), "test#3 excluded (dep test#2 not done)");
  assert(!frontierIds.includes("test#4"), "test#4 excluded (needs_human=true)");
  assert(frontierIds.length === 1, "Exactly 1 frontier item");

  // ── Test 2: Mark done and recompute frontier ─────────────────────
  console.log("\n2. Mark done + frontier recompute");

  db.prepare(
    "UPDATE work_items SET state = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run("test#2");

  const frontier2 = db.prepare(`
    SELECT w.id
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
      AND NOT EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
    ORDER BY w.id
  `).all() as { id: string }[];

  const frontier2Ids = frontier2.map((r) => r.id);
  assert(frontier2Ids.includes("test#3"), "test#3 now on frontier after test#2 done");
  assert(!frontier2Ids.includes("test#2"), "test#2 no longer on frontier (now done)");

  // ── Test 3: Hierarchical status rollup ───────────────────────────
  console.log("\n3. Status rollup");

  const rollup = db.prepare(`
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
      COUNT(CASE WHEN leaf.kind IN ('issue', 'capability') THEN 1 END) AS total_items,
      COUNT(CASE WHEN leaf.kind IN ('issue', 'capability') AND leaf.state = 'done' THEN 1 END) AS done_items
    FROM tree
    JOIN work_items root ON root.id = tree.root_id
    JOIN work_items leaf ON leaf.id = tree.child_id
    GROUP BY root.id, root.name
    ORDER BY root.name
  `).all() as { name: string; total_items: number; done_items: number }[];

  // Track has 3 direct issues (test#1, test#2, test#3); test#4 not part of track
  const track = rollup.find((r) => r.name === "API Layer");
  assert(track !== undefined, "API Layer track found in rollup");
  assert(track!.total_items === 3, "Track has 3 total issue items");
  assert(track!.done_items === 2, "Track has 2 done items (test#1, test#2)");

  // Phase rolls up through track, so it should see the same leaf items
  const phase = rollup.find((r) => r.name === "Phase 1: Test Infrastructure");
  assert(phase !== undefined, "Phase found in rollup");
  assert(phase!.total_items === 3, "Phase has 3 total items (via track)");
  assert(phase!.done_items === 2, "Phase has 2 done items (via track)");

  // ── Test 4: Item not found handling ──────────────────────────────
  console.log("\n4. Edge cases");

  const missing = db.prepare(
    "SELECT id FROM work_items WHERE id = ?"
  ).all("nonexistent") as { id: string }[];
  assert(missing.length === 0, "Nonexistent item returns empty result");

  const alreadyDone = db.prepare(
    "SELECT state FROM work_items WHERE id = ?"
  ).get("test#1") as { state: string };
  assert(alreadyDone.state === "done", "test#1 state is 'done'");

  // ── Done ─────────────────────────────────────────────────────────
  db.close();
  console.log("\nAll tests passed.");
}

try {
  run();
} catch (err: any) {
  console.error(err);
  process.exit(1);
}
