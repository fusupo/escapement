import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initManifest } from "./init.ts";
import { buildDispatchPlan, formatPlan } from "./plan.ts";
import type { PGlite } from "@electric-sql/pglite";

// ── Helpers ──────────────────────────────────────────────────────────

function usage(): never {
  console.log(`Usage: manifest <command> [args]

Commands:
  seed <file.sql>   Load a SQL seed file into the manifest database
  frontier          Display dispatchable work items (planned, no unmet deps)
  done <id>         Mark a work item as done and show updated frontier
  status            Show overall progress (phase/track rollup)
  plan              Generate dispatch plan with parallel groups and overlaps`);
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

async function cmdPlan(db: PGlite): Promise<void> {
  const plan = await buildDispatchPlan(db);
  console.log(formatPlan(plan));
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
      case "plan":
        await cmdPlan(db);
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
