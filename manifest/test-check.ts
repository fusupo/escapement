import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applySchema } from "./init.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tests for the manifest check subcommands:
 *   - superseded: detect in_progress items superseded by newer ones
 *   - reconcile: compare predicted vs actual files
 *   - overlap: re-run file overlap on frontier
 *   - drift: detect repeated prediction misses
 *   - new-issues: list manifest issue numbers
 */

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v === "string") return JSON.parse(v);
  if (Array.isArray(v)) return v;
  return [];
}

function seedCheckTestData(db: Database.Database) {
  db.exec(`
    -- Phase/track structure
    INSERT INTO work_items (id, name, kind, state) VALUES
      ('phase:core', 'Phase 1: Core', 'phase', 'planned'),
      ('track:core:api', 'API Track', 'track', 'planned');

    -- An older in_progress item
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      predicted_files, actual_files, meta, updated_at
    ) VALUES (
      'test#10',
      'Build the widget',
      'issue',
      'in_progress',
      'test-org/test-repo',
      10,
      'https://github.com/test-org/test-repo/issues/10',
      '["src/widget.ts", "src/utils.ts"]',
      '[]',
      '{"bootstrap_status":"active","needs_human":false}',
      '2026-01-01T00:00:00Z'
    );

    -- A newer planned item that overlaps with test#10
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      predicted_files, meta, updated_at
    ) VALUES (
      'test#20',
      'Refactor widget system',
      'issue',
      'planned',
      'test-org/test-repo',
      20,
      'https://github.com/test-org/test-repo/issues/20',
      '["src/widget.ts", "src/widget-v2.ts"]',
      '{"bootstrap_status":"active","needs_human":false}',
      '2026-03-01T00:00:00Z'
    );

    -- A done item with both predicted and actual files (for reconciliation)
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      predicted_files, actual_files, meta
    ) VALUES (
      'test#5',
      'Setup database layer',
      'issue',
      'done',
      'test-org/test-repo',
      5,
      'https://github.com/test-org/test-repo/issues/5',
      '["src/db.ts", "src/model.ts", "src/config.ts"]',
      '["src/db.ts", "src/model.ts", "src/migrations.ts"]',
      '{"bootstrap_status":"active","needs_human":false}'
    );

    -- Another done item with reconciliation data (for drift testing)
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      predicted_files, actual_files, meta
    ) VALUES (
      'test#6',
      'Add auth middleware',
      'issue',
      'done',
      'test-org/test-repo',
      6,
      'https://github.com/test-org/test-repo/issues/6',
      '["src/auth.ts", "src/middleware.ts"]',
      '["src/auth.ts", "src/middleware.ts", "src/migrations.ts", "src/config.ts"]',
      '{"bootstrap_status":"active","needs_human":false}'
    );

    -- A frontier item with no overlap (isolated)
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      predicted_files, meta
    ) VALUES (
      'test#30',
      'Write docs',
      'issue',
      'planned',
      'test-org/test-repo',
      30,
      'https://github.com/test-org/test-repo/issues/30',
      '["docs/README.md"]',
      '{"bootstrap_status":"active","needs_human":false}'
    );

    -- Edges
    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('track:core:api', 'is_part_of', 'phase:core', 'certain'),
      ('test#10', 'is_part_of', 'track:core:api', 'certain'),
      ('test#20', 'is_part_of', 'track:core:api', 'certain'),
      ('test#5', 'is_part_of', 'track:core:api', 'certain'),
      ('test#6', 'is_part_of', 'track:core:api', 'certain'),
      ('test#30', 'is_part_of', 'track:core:api', 'certain');
  `);
}

function run() {
  console.log("Manifest check subcommand tests\n");

  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedCheckTestData(db);
  console.log("  \u2713 Test data seeded\n");

  // ── Test 1: Supersession detection ──────────────────────────────
  console.log("1. Supersession detection (SQL query)");

  const supersededSql = readFileSync(
    resolve(__dirname, "queries", "superseded.sql"),
    "utf-8"
  );
  const superseded = db.prepare(supersededSql).all() as {
    older_id: string;
    newer_id: string;
    shared_files: string;
  }[];

  assert(superseded.length === 1, "Exactly 1 supersession pair detected");
  assert(
    superseded[0].older_id === "test#10",
    "Older item is test#10 (in_progress)"
  );
  assert(
    superseded[0].newer_id === "test#20",
    "Newer item is test#20 (planned, overlapping files)"
  );
  const supersededFiles = parseJsonArray(superseded[0].shared_files);
  assert(
    supersededFiles.includes("src/widget.ts"),
    "Shared file src/widget.ts detected"
  );
  assert(
    supersededFiles.length === 1,
    "Only 1 shared file (src/widget.ts)"
  );

  // ── Test 2: Reconciliation ──────────────────────────────────────
  console.log("\n2. Reconciliation (SQL query)");

  const reconcileSql = readFileSync(
    resolve(__dirname, "queries", "reconcile.sql"),
    "utf-8"
  );
  const reconcile = db.prepare(reconcileSql).all() as {
    id: string;
    hits: string;
    misses: string;
    false_positives: string;
  }[];

  assert(reconcile.length === 2, "2 items eligible for reconciliation");

  const item5 = reconcile.find((r) => r.id === "test#5");
  assert(item5 !== undefined, "test#5 found in reconciliation");
  const item5hits = parseJsonArray(item5!.hits);
  const item5misses = parseJsonArray(item5!.misses);
  const item5fp = parseJsonArray(item5!.false_positives);
  assert(
    item5hits.length === 2,
    "test#5 has 2 hits (src/db.ts, src/model.ts)"
  );
  assert(
    item5misses.includes("src/migrations.ts"),
    "test#5 missed src/migrations.ts"
  );
  assert(
    item5fp.includes("src/config.ts"),
    "test#5 false positive: src/config.ts"
  );

  const item6 = reconcile.find((r) => r.id === "test#6");
  assert(item6 !== undefined, "test#6 found in reconciliation");
  const item6hits = parseJsonArray(item6!.hits);
  const item6misses = parseJsonArray(item6!.misses);
  assert(
    item6hits.length === 2,
    "test#6 has 2 hits (src/auth.ts, src/middleware.ts)"
  );
  assert(
    item6misses.includes("src/migrations.ts"),
    "test#6 missed src/migrations.ts"
  );
  assert(
    item6misses.includes("src/config.ts"),
    "test#6 missed src/config.ts"
  );

  // ── Test 3: Overlap re-run ─────────────────────────────────────
  console.log("\n3. Overlap re-run (SQL query)");

  const overlapSql = readFileSync(
    resolve(__dirname, "queries", "overlap.sql"),
    "utf-8"
  );
  const overlap = db.prepare(overlapSql).all() as {
    node_a: string;
    node_b: string;
    shared_files: string;
  }[];

  assert(
    overlap.length === 0,
    "No overlap among frontier items (test#20 and test#30 have disjoint files)"
  );

  // Add another frontier item that overlaps with test#20
  db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, predicted_files, meta
    ) VALUES (
      'test#21',
      'Widget tests',
      'issue',
      'planned',
      '["src/widget.ts", "tests/widget.test.ts"]',
      '{"needs_human":false}'
    )
  `);

  const overlap2 = db.prepare(overlapSql).all() as {
    node_a: string;
    node_b: string;
    shared_files: string;
  }[];

  assert(overlap2.length === 1, "1 overlap pair after adding test#21");
  const overlap2Files = parseJsonArray(overlap2[0].shared_files);
  assert(
    overlap2Files.includes("src/widget.ts"),
    "Overlap is on src/widget.ts"
  );

  // ── Test 4: Drift detection ────────────────────────────────────
  console.log("\n4. Drift detection");

  // Simulate reconciliation being stored in meta
  db.prepare(
    `UPDATE work_items SET meta = json_set(meta, '$.reconciliation', json(?)) WHERE id = ?`
  ).run(
    JSON.stringify({
      hits: ["src/db.ts", "src/model.ts"],
      misses: ["src/migrations.ts"],
      false_positives: ["src/config.ts"],
      accuracy: 0.5,
      checked_at: new Date().toISOString(),
    }),
    "test#5"
  );
  db.prepare(
    `UPDATE work_items SET meta = json_set(meta, '$.reconciliation', json(?)) WHERE id = ?`
  ).run(
    JSON.stringify({
      hits: ["src/auth.ts", "src/middleware.ts"],
      misses: ["src/migrations.ts", "src/config.ts"],
      false_positives: [],
      accuracy: 0.5,
      checked_at: new Date().toISOString(),
    }),
    "test#6"
  );

  // Now query for drift (files missed in 2+ items)
  const driftResult = db.prepare(`
    SELECT id, json_extract(meta, '$.reconciliation.misses') AS misses
    FROM work_items
    WHERE json_extract(meta, '$.reconciliation.misses') IS NOT NULL
      AND json_array_length(json_extract(meta, '$.reconciliation.misses')) > 0
  `).all() as { id: string; misses: string }[];

  assert(driftResult.length === 2, "2 items have reconciliation misses");

  // Compute drift frequency
  const fileMissCounts: Record<string, string[]> = {};
  for (const row of driftResult) {
    const misses = parseJsonArray(row.misses);
    for (const file of misses) {
      if (!fileMissCounts[file]) fileMissCounts[file] = [];
      fileMissCounts[file].push(row.id);
    }
  }

  const driftFiles = Object.entries(fileMissCounts).filter(
    ([, ids]) => ids.length >= 2
  );

  assert(driftFiles.length === 1, "1 drift file detected (src/migrations.ts)");
  assert(
    driftFiles[0][0] === "src/migrations.ts",
    "Drift file is src/migrations.ts"
  );
  assert(
    driftFiles[0][1].length === 2,
    "src/migrations.ts missed in 2 items"
  );

  // ── Test 5: New issues listing ─────────────────────────────────
  console.log("\n5. New issues listing");

  const newIssues = db.prepare(`
    SELECT repo, issue_number
    FROM work_items
    WHERE issue_number IS NOT NULL AND repo IS NOT NULL
    ORDER BY repo, issue_number
  `).all() as { repo: string; issue_number: number }[];

  assert(newIssues.length === 5, "5 issues with issue_number in manifest");
  const numbers = newIssues.map((r) => r.issue_number);
  assert(numbers.includes(5), "Issue #5 present");
  assert(numbers.includes(6), "Issue #6 present");
  assert(numbers.includes(10), "Issue #10 present");
  assert(numbers.includes(20), "Issue #20 present");
  assert(numbers.includes(30), "Issue #30 present");

  // ── Test 6: Supersession with scope_hint match ─────────────────
  console.log("\n6. Supersession via scope_hint (no file overlap)");

  db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, scope_hint,
      predicted_files, meta, updated_at
    ) VALUES (
      'test#40',
      'Old auth refactor',
      'issue',
      'in_progress',
      'auth-system',
      '["src/old-auth.ts"]',
      '{"needs_human":false}',
      '2026-01-15T00:00:00Z'
    ), (
      'test#50',
      'New auth system',
      'issue',
      'planned',
      'auth-system',
      '["src/new-auth.ts"]',
      '{"needs_human":false}',
      '2026-03-15T00:00:00Z'
    )
  `);

  const superseded2 = db.prepare(supersededSql).all() as {
    older_id: string;
    newer_id: string;
    shared_files: string;
  }[];

  const scopeMatch = superseded2.find(
    (r) => r.older_id === "test#40" && r.newer_id === "test#50"
  );
  assert(scopeMatch !== undefined, "Scope-based supersession detected (test#40 -> test#50)");
  const scopeFiles = parseJsonArray(scopeMatch!.shared_files);
  assert(
    scopeFiles.length === 0,
    "No shared files (supersession is scope-based)"
  );

  // ── Done ────────────────────────────────────────────────────────
  db.close();
  console.log("\nAll tests passed.");
}

try {
  run();
} catch (err: any) {
  console.error(err);
  process.exit(1);
}
