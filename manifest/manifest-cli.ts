import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initManifest } from "./init.ts";
import type { PGlite } from "@electric-sql/pglite";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────

function usage(): never {
  console.log(`Usage: manifest <command> [args]

Commands:
  seed <file.sql>   Load a SQL seed file into the manifest database
  frontier          Display dispatchable work items (planned, no unmet deps)
  done <id>         Mark a work item as done and show updated frontier
  status            Show overall progress (phase/track rollup)
  check <sub>       Run manifest health checks

Check subcommands:
  check superseded         Detect in_progress items superseded by newer ones
  check reconcile          Compare predicted vs actual files for done items
  check overlap            Re-run file overlap analysis on current frontier
  check drift              Analyze and record repeated prediction misses
  check new-issues         List manifest issue_numbers for diffing against GitHub`);
  process.exit(1);
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function pct(done: number, total: number): string {
  if (total === 0) return "  --%";
  return `${Math.round((done / total) * 100).toString().padStart(3)}%`;
}

// ── Commands ─────────────────────────────────────────────────────────

async function cmdSeed(db: PGlite, args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    console.error("Error: seed requires a SQL file path.\n  manifest seed <file.sql>");
    process.exit(1);
  }
  const resolved = resolve(filePath);
  let sql: string;
  try {
    sql = readFileSync(resolved, "utf-8");
  } catch (err) {
    console.error(`Error: cannot read file: ${resolved}`);
    process.exit(1);
  }
  await db.exec(sql);
  // Report what was loaded
  const items = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM work_items"
  );
  const edges = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM edges"
  );
  console.log(
    `Seed applied.\n  work_items: ${items.rows[0].count}\n  edges:      ${edges.rows[0].count}`
  );
}

async function cmdFrontier(db: PGlite): Promise<void> {
  const result = await db.query<{
    id: string;
    name: string;
    kind: string;
    repo: string | null;
    scope_hint: string | null;
  }>(`
    SELECT w.id, w.name, w.kind, w.repo, w.scope_hint
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

  if (result.rows.length === 0) {
    console.log("No dispatchable work items.");
    return;
  }

  console.log(`Frontier: ${result.rows.length} dispatchable item(s)\n`);
  console.log(
    `  ${pad("ID", 20)} ${pad("KIND", 12)} ${pad("REPO", 24)} NAME`
  );
  console.log(`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(24)} ${"─".repeat(30)}`);
  for (const row of result.rows) {
    console.log(
      `  ${pad(row.id, 20)} ${pad(row.kind, 12)} ${pad(row.repo ?? "-", 24)} ${row.name}`
    );
  }
}

async function cmdDone(db: PGlite, args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error("Error: done requires a work item id.\n  manifest done <id>");
    process.exit(1);
  }

  // Check item exists
  const existing = await db.query<{ id: string; state: string }>(
    "SELECT id, state FROM work_items WHERE id = $1",
    [id]
  );
  if (existing.rows.length === 0) {
    console.error(`Error: work item '${id}' not found.`);
    process.exit(1);
  }
  if (existing.rows[0].state === "done") {
    console.log(`Work item '${id}' is already done.`);
    return;
  }

  await db.query(
    "UPDATE work_items SET state = 'done', updated_at = now() WHERE id = $1",
    [id]
  );
  console.log(`Marked '${id}' as done.\n`);

  // Show updated frontier
  await cmdFrontier(db);
}

async function cmdStatus(db: PGlite): Promise<void> {
  // Summary counts across all work items
  const summary = await db.query<{
    state: string;
    count: string;
  }>("SELECT state, count(*)::text AS count FROM work_items GROUP BY state ORDER BY state");

  let total = 0;
  const byState: Record<string, number> = {};
  for (const row of summary.rows) {
    byState[row.state] = parseInt(row.count, 10);
    total += byState[row.state];
  }

  console.log("Overall Status\n");
  console.log(`  Total items: ${total}`);
  for (const s of ["planned", "in_progress", "done", "deferred", "cancelled"]) {
    if (byState[s]) {
      console.log(`  ${pad(s, 14)} ${byState[s]}`);
    }
  }

  // Hierarchical rollup
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

  if (rollup.rows.length > 0) {
    console.log(`\nPhase / Track Rollup\n`);
    console.log(
      `  ${pad("NAME", 44)} ${pad("DONE", 6)} ${pad("TOTAL", 6)} PROGRESS`
    );
    console.log(
      `  ${"─".repeat(44)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(8)}`
    );
    for (const row of rollup.rows) {
      const done = parseInt(row.done_items, 10);
      const tot = parseInt(row.total_items, 10);
      console.log(
        `  ${pad(row.name, 44)} ${pad(String(done), 6)} ${pad(String(tot), 6)} ${pct(done, tot)}`
      );
    }
  }
}

// ── Check subcommands ───────────────────────────────────────────────

async function cmdCheckSuperseded(db: PGlite): Promise<void> {
  const sqlPath = resolve(__dirname, "queries", "superseded.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const result = await db.query<{
    older_id: string;
    older_name: string;
    older_scope: string | null;
    newer_id: string;
    newer_name: string;
    newer_scope: string | null;
    shared_files: string[];
  }>(sql);

  if (result.rows.length === 0) {
    console.log("No superseded in_progress items detected.");
    return;
  }

  console.log(`Supersession Check: ${result.rows.length} potential supersession(s)\n`);
  console.log(
    `  ${pad("OLDER ITEM", 20)} ${pad("NEWER ITEM", 20)} SHARED FILES`
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(40)}`
  );
  for (const row of result.rows) {
    const files = row.shared_files.length > 0 ? row.shared_files.join(", ") : "(scope match)";
    console.log(`  ${pad(row.older_id, 20)} ${pad(row.newer_id, 20)} ${files}`);
    console.log(`    ${row.older_name}`);
    console.log(`    -> ${row.newer_name}`);
    console.log();
  }
}

async function cmdCheckReconcile(db: PGlite): Promise<void> {
  const sqlPath = resolve(__dirname, "queries", "reconcile.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const result = await db.query<{
    id: string;
    name: string;
    predicted_files: string[];
    actual_files: string[];
    hits: string[];
    misses: string[];
    false_positives: string[];
  }>(sql);

  if (result.rows.length === 0) {
    console.log("No completed items with both predicted and actual files. Reconciliation skipped.");
    return;
  }

  console.log(`Reconciliation: ${result.rows.length} item(s)\n`);

  let totalHits = 0;
  let totalMisses = 0;
  let totalFP = 0;

  for (const row of result.rows) {
    const h = row.hits.length;
    const m = row.misses.length;
    const fp = row.false_positives.length;
    const denom = h + m + fp;
    const accuracy = denom === 0 ? 100 : Math.round((h / denom) * 100);

    totalHits += h;
    totalMisses += m;
    totalFP += fp;

    console.log(`  ${row.id}: ${row.name}`);
    console.log(`    Predicted: ${row.predicted_files.length} files`);
    console.log(`    Actual:    ${row.actual_files.length} files`);
    console.log(`    Hits:      ${h}  Misses: ${m}  False pos: ${fp}  Accuracy: ${accuracy}%`);
    if (m > 0) console.log(`    Missed:    ${row.misses.join(", ")}`);
    if (fp > 0) console.log(`    False pos: ${row.false_positives.join(", ")}`);
    console.log();

    // Store reconciliation in meta
    await db.query(
      `UPDATE work_items
       SET meta = jsonb_set(
         meta,
         '{reconciliation}',
         $1::jsonb
       ),
       updated_at = now()
       WHERE id = $2`,
      [
        JSON.stringify({
          hits: row.hits,
          misses: row.misses,
          false_positives: row.false_positives,
          accuracy: denom === 0 ? 1.0 : h / denom,
          checked_at: new Date().toISOString(),
        }),
        row.id,
      ]
    );
  }

  const totalDenom = totalHits + totalMisses + totalFP;
  const overallAccuracy = totalDenom === 0 ? 100 : Math.round((totalHits / totalDenom) * 100);
  console.log(`  Overall: ${totalHits} hits, ${totalMisses} misses, ${totalFP} false positives — ${overallAccuracy}% accuracy`);
}

async function cmdCheckOverlap(db: PGlite): Promise<void> {
  const sqlPath = resolve(__dirname, "queries", "overlap.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const result = await db.query<{
    node_a: string;
    node_b: string;
    shared_files: string[];
  }>(sql);

  // Count frontier items
  const frontierCount = await db.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE((w.meta->>'needs_human')::boolean, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
  `);

  console.log(`File Overlap Analysis (current frontier)\n`);
  console.log(`  Frontier items: ${frontierCount.rows[0].count}`);

  if (result.rows.length === 0) {
    console.log("  No overlapping file sets detected.");
    return;
  }

  console.log(`  Overlapping pairs: ${result.rows.length}\n`);
  console.log(
    `  ${pad("ITEM A", 20)} ${pad("ITEM B", 20)} SHARED FILES`
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(40)}`
  );
  for (const row of result.rows) {
    console.log(
      `  ${pad(row.node_a, 20)} ${pad(row.node_b, 20)} ${row.shared_files.join(", ")}`
    );
  }
}

async function cmdCheckDrift(db: PGlite): Promise<void> {
  // Find files that appear as misses in multiple reconciliation records
  const result = await db.query<{
    id: string;
    misses: string[];
  }>(`
    SELECT id, meta->'reconciliation'->'misses' AS misses
    FROM work_items
    WHERE meta->'reconciliation'->'misses' IS NOT NULL
      AND jsonb_array_length(meta->'reconciliation'->'misses') > 0
  `);

  if (result.rows.length === 0) {
    console.log("No reconciliation data available for drift analysis.");
    console.log("Run 'manifest check reconcile' first on items with actual_files.");
    return;
  }

  // Count miss frequency across items
  const fileMissCounts: Record<string, string[]> = {};
  for (const row of result.rows) {
    const misses: string[] = typeof row.misses === "string"
      ? JSON.parse(row.misses)
      : row.misses as unknown as string[];
    for (const file of misses) {
      if (!fileMissCounts[file]) fileMissCounts[file] = [];
      fileMissCounts[file].push(row.id);
    }
  }

  // Filter to files missed in 2+ items
  const driftFiles = Object.entries(fileMissCounts)
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  console.log("Drift Analysis\n");

  if (driftFiles.length === 0) {
    console.log("  No repeated drift patterns detected (need 2+ misses for same file).");
    console.log(`  Reconciliation data available for ${result.rows.length} item(s).`);
    return;
  }

  console.log(`  Frequently missed files (appeared in 2+ reconciliation misses):\n`);
  for (const [file, ids] of driftFiles) {
    console.log(`    ${file}: missed in ${ids.length} items (${ids.join(", ")})`);
  }

  // Record drift patterns on affected items
  const affectedItems = new Set<string>();
  const driftFileList = driftFiles.map(([f]) => f);
  for (const [, ids] of driftFiles) {
    for (const id of ids) affectedItems.add(id);
  }

  for (const id of affectedItems) {
    await db.query(
      `UPDATE work_items
       SET meta = jsonb_set(
         meta,
         '{drift_patterns}',
         $1::jsonb
       ),
       updated_at = now()
       WHERE id = $2`,
      [
        JSON.stringify({
          files: driftFileList,
          frequency: driftFiles.reduce((sum, [, ids]) =>
            ids.includes(id) ? sum + 1 : sum, 0),
          recorded_at: new Date().toISOString(),
        }),
        id,
      ]
    );
  }

  console.log(`\n  Drift patterns recorded on ${affectedItems.size} item(s).`);
}

async function cmdCheckNewIssues(db: PGlite): Promise<void> {
  // List all issue_numbers currently in the manifest, grouped by repo
  const result = await db.query<{
    repo: string;
    issue_number: number;
  }>(`
    SELECT repo, issue_number
    FROM work_items
    WHERE issue_number IS NOT NULL AND repo IS NOT NULL
    ORDER BY repo, issue_number
  `);

  if (result.rows.length === 0) {
    console.log("No issues in manifest. Run manifest-bootstrap first.");
    return;
  }

  const byRepo: Record<string, number[]> = {};
  for (const row of result.rows) {
    if (!byRepo[row.repo]) byRepo[row.repo] = [];
    byRepo[row.repo].push(row.issue_number);
  }

  console.log("Manifest Issue Numbers (for diffing against GitHub):\n");
  for (const [repo, numbers] of Object.entries(byRepo)) {
    console.log(`  ${repo}: ${numbers.join(", ")}`);
  }
  console.log(`\n  Total: ${result.rows.length} issue(s) across ${Object.keys(byRepo).length} repo(s)`);
}

async function cmdCheck(db: PGlite, args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub) {
    // Run all checks in sequence
    console.log("=== Supersession Check ===\n");
    await cmdCheckSuperseded(db);
    console.log("\n=== Reconciliation ===\n");
    await cmdCheckReconcile(db);
    console.log("\n=== Overlap Analysis ===\n");
    await cmdCheckOverlap(db);
    console.log("\n=== Drift Analysis ===\n");
    await cmdCheckDrift(db);
    return;
  }

  switch (sub) {
    case "superseded":
      await cmdCheckSuperseded(db);
      break;
    case "reconcile":
      await cmdCheckReconcile(db);
      break;
    case "overlap":
      await cmdCheckOverlap(db);
      break;
    case "drift":
      await cmdCheckDrift(db);
      break;
    case "new-issues":
      await cmdCheckNewIssues(db);
      break;
    default:
      console.error(`Unknown check subcommand: ${sub}`);
      console.error("Available: superseded, reconcile, overlap, drift, new-issues");
      process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) usage();

  const db = await initManifest();

  try {
    switch (command) {
      case "seed":
        await cmdSeed(db, args.slice(1));
        break;
      case "frontier":
        await cmdFrontier(db);
        break;
      case "done":
        await cmdDone(db, args.slice(1));
        break;
      case "status":
        await cmdStatus(db);
        break;
      case "check":
        await cmdCheck(db, args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        usage();
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
