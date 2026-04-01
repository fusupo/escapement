import { PGlite } from "@electric-sql/pglite";
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

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function seedCheckTestData(db: PGlite) {
  await db.exec(`
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
      ARRAY['src/widget.ts', 'src/utils.ts'],
      '{}',
      '{"bootstrap_status":"active","needs_human":false}'::jsonb,
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
      ARRAY['src/widget.ts', 'src/widget-v2.ts'],
      '{"bootstrap_status":"active","needs_human":false}'::jsonb,
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
      ARRAY['src/db.ts', 'src/model.ts', 'src/config.ts'],
      ARRAY['src/db.ts', 'src/model.ts', 'src/migrations.ts'],
      '{"bootstrap_status":"active","needs_human":false}'::jsonb
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
      ARRAY['src/auth.ts', 'src/middleware.ts'],
      ARRAY['src/auth.ts', 'src/middleware.ts', 'src/migrations.ts', 'src/config.ts'],
      '{"bootstrap_status":"active","needs_human":false}'::jsonb
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
      ARRAY['docs/README.md'],
      '{"bootstrap_status":"active","needs_human":false}'::jsonb
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

async function run() {
  console.log("Manifest check subcommand tests\n");

  const db = await PGlite.create("memory://");
  await applySchema(db);
  await seedCheckTestData(db);
  console.log("  ✓ Test data seeded\n");

  // ── Test 1: Supersession detection ──────────────────────────────
  console.log("1. Supersession detection (SQL query)");

  const supersededSql = readFileSync(
    resolve(__dirname, "queries", "superseded.sql"),
    "utf-8"
  );
  const superseded = await db.query<{
    older_id: string;
    newer_id: string;
    shared_files: string[];
  }>(supersededSql);

  await assert(superseded.rows.length === 1, "Exactly 1 supersession pair detected");
  await assert(
    superseded.rows[0].older_id === "test#10",
    "Older item is test#10 (in_progress)"
  );
  await assert(
    superseded.rows[0].newer_id === "test#20",
    "Newer item is test#20 (planned, overlapping files)"
  );
  await assert(
    superseded.rows[0].shared_files.includes("src/widget.ts"),
    "Shared file src/widget.ts detected"
  );
  await assert(
    superseded.rows[0].shared_files.length === 1,
    "Only 1 shared file (src/widget.ts)"
  );

  // ── Test 2: Reconciliation ──────────────────────────────────────
  console.log("\n2. Reconciliation (SQL query)");

  const reconcileSql = readFileSync(
    resolve(__dirname, "queries", "reconcile.sql"),
    "utf-8"
  );
  const reconcile = await db.query<{
    id: string;
    hits: string[];
    misses: string[];
    false_positives: string[];
  }>(reconcileSql);

  await assert(reconcile.rows.length === 2, "2 items eligible for reconciliation");

  const item5 = reconcile.rows.find((r) => r.id === "test#5");
  await assert(item5 !== undefined, "test#5 found in reconciliation");
  await assert(
    item5!.hits.length === 2,
    "test#5 has 2 hits (src/db.ts, src/model.ts)"
  );
  await assert(
    item5!.misses.includes("src/migrations.ts"),
    "test#5 missed src/migrations.ts"
  );
  await assert(
    item5!.false_positives.includes("src/config.ts"),
    "test#5 false positive: src/config.ts"
  );

  const item6 = reconcile.rows.find((r) => r.id === "test#6");
  await assert(item6 !== undefined, "test#6 found in reconciliation");
  await assert(
    item6!.hits.length === 2,
    "test#6 has 2 hits (src/auth.ts, src/middleware.ts)"
  );
  await assert(
    item6!.misses.includes("src/migrations.ts"),
    "test#6 missed src/migrations.ts"
  );
  await assert(
    item6!.misses.includes("src/config.ts"),
    "test#6 missed src/config.ts"
  );

  // ── Test 3: Overlap re-run ─────────────────────────────────────
  console.log("\n3. Overlap re-run (SQL query)");

  const overlapSql = readFileSync(
    resolve(__dirname, "queries", "overlap.sql"),
    "utf-8"
  );
  const overlap = await db.query<{
    node_a: string;
    node_b: string;
    shared_files: string[];
  }>(overlapSql);

  // test#20 (planned, frontier) and test#30 (planned, frontier) have no overlap
  // test#20 shares src/widget.ts with test#10, but test#10 is in_progress not planned
  // So the frontier overlap check only considers planned items
  await assert(
    overlap.rows.length === 0,
    "No overlap among frontier items (test#20 and test#30 have disjoint files)"
  );

  // Add another frontier item that overlaps with test#20
  await db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, predicted_files, meta
    ) VALUES (
      'test#21',
      'Widget tests',
      'issue',
      'planned',
      ARRAY['src/widget.ts', 'tests/widget.test.ts'],
      '{"needs_human":false}'::jsonb
    )
  `);

  const overlap2 = await db.query<{
    node_a: string;
    node_b: string;
    shared_files: string[];
  }>(overlapSql);

  await assert(overlap2.rows.length === 1, "1 overlap pair after adding test#21");
  await assert(
    overlap2.rows[0].shared_files.includes("src/widget.ts"),
    "Overlap is on src/widget.ts"
  );

  // ── Test 4: Drift detection ────────────────────────────────────
  console.log("\n4. Drift detection");

  // First, simulate reconciliation being stored in meta (as the CLI reconcile command does)
  await db.query(
    `UPDATE work_items SET meta = jsonb_set(meta, '{reconciliation}', $1::jsonb) WHERE id = $2`,
    [
      JSON.stringify({
        hits: ["src/db.ts", "src/model.ts"],
        misses: ["src/migrations.ts"],
        false_positives: ["src/config.ts"],
        accuracy: 0.5,
        checked_at: new Date().toISOString(),
      }),
      "test#5",
    ]
  );
  await db.query(
    `UPDATE work_items SET meta = jsonb_set(meta, '{reconciliation}', $1::jsonb) WHERE id = $2`,
    [
      JSON.stringify({
        hits: ["src/auth.ts", "src/middleware.ts"],
        misses: ["src/migrations.ts", "src/config.ts"],
        false_positives: [],
        accuracy: 0.5,
        checked_at: new Date().toISOString(),
      }),
      "test#6",
    ]
  );

  // Now query for drift (files missed in 2+ items)
  const driftResult = await db.query<{
    id: string;
    misses: unknown;
  }>(`
    SELECT id, meta->'reconciliation'->'misses' AS misses
    FROM work_items
    WHERE meta->'reconciliation'->'misses' IS NOT NULL
      AND jsonb_array_length(meta->'reconciliation'->'misses') > 0
  `);

  await assert(driftResult.rows.length === 2, "2 items have reconciliation misses");

  // Compute drift frequency
  const fileMissCounts: Record<string, string[]> = {};
  for (const row of driftResult.rows) {
    const misses: string[] =
      typeof row.misses === "string"
        ? JSON.parse(row.misses)
        : (row.misses as string[]);
    for (const file of misses) {
      if (!fileMissCounts[file]) fileMissCounts[file] = [];
      fileMissCounts[file].push(row.id);
    }
  }

  const driftFiles = Object.entries(fileMissCounts).filter(
    ([, ids]) => ids.length >= 2
  );

  await assert(driftFiles.length === 1, "1 drift file detected (src/migrations.ts)");
  await assert(
    driftFiles[0][0] === "src/migrations.ts",
    "Drift file is src/migrations.ts"
  );
  await assert(
    driftFiles[0][1].length === 2,
    "src/migrations.ts missed in 2 items"
  );

  // ── Test 5: New issues listing ─────────────────────────────────
  console.log("\n5. New issues listing");

  const newIssues = await db.query<{
    repo: string;
    issue_number: number;
  }>(`
    SELECT repo, issue_number
    FROM work_items
    WHERE issue_number IS NOT NULL AND repo IS NOT NULL
    ORDER BY repo, issue_number
  `);

  await assert(newIssues.rows.length === 5, "5 issues with issue_number in manifest");
  const numbers = newIssues.rows.map((r) => r.issue_number);
  await assert(numbers.includes(5), "Issue #5 present");
  await assert(numbers.includes(6), "Issue #6 present");
  await assert(numbers.includes(10), "Issue #10 present");
  await assert(numbers.includes(20), "Issue #20 present");
  await assert(numbers.includes(30), "Issue #30 present");

  // ── Test 6: Supersession with scope_hint match ─────────────────
  console.log("\n6. Supersession via scope_hint (no file overlap)");

  await db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, scope_hint,
      predicted_files, meta, updated_at
    ) VALUES (
      'test#40',
      'Old auth refactor',
      'issue',
      'in_progress',
      'auth-system',
      ARRAY['src/old-auth.ts'],
      '{"needs_human":false}'::jsonb,
      '2026-01-15T00:00:00Z'
    ), (
      'test#50',
      'New auth system',
      'issue',
      'planned',
      'auth-system',
      ARRAY['src/new-auth.ts'],
      '{"needs_human":false}'::jsonb,
      '2026-03-15T00:00:00Z'
    )
  `);

  const superseded2 = await db.query<{
    older_id: string;
    newer_id: string;
    shared_files: string[];
  }>(supersededSql);

  const scopeMatch = superseded2.rows.find(
    (r) => r.older_id === "test#40" && r.newer_id === "test#50"
  );
  await assert(scopeMatch !== undefined, "Scope-based supersession detected (test#40 -> test#50)");
  await assert(
    scopeMatch!.shared_files.length === 0,
    "No shared files (supersession is scope-based)"
  );

  // ── Done ────────────────────────────────────────────────────────
  await db.close();
  console.log("\nAll tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
