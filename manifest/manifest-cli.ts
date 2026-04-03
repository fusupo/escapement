import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initManifest } from "./init.ts";
import { buildDispatchPlan, formatPlan } from "./plan.ts";
import type { Database } from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────

function usage(): never {
  console.log(`Usage: manifest [--data-dir <path>] <command> [args]

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
  check new-issues         List manifest issue_numbers for diffing against GitHub
  plan              Generate dispatch plan with parallel groups and overlaps
  query <sql>       Execute inline SQL and print results
  in-progress <id> <branch>  Mark a work item as in_progress and record its branch

Options:
  --data-dir <path>  Override the manifest data directory`);
  process.exit(1);
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function pct(done: number, total: number): string {
  if (total === 0) return "  --%";
  return `${Math.round((done / total) * 100).toString().padStart(3)}%`;
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v === "string") return JSON.parse(v);
  if (Array.isArray(v)) return v;
  return [];
}

// ── Commands ─────────────────────────────────────────────────────────

function cmdSeed(db: Database, args: string[]): void {
  const filePath = args[0];
  if (!filePath) {
    console.error("Error: seed requires a SQL file path.\n  manifest seed <file.sql>");
    process.exit(1);
  }
  const resolved = resolve(filePath);
  let sql: string;
  try {
    sql = readFileSync(resolved, "utf-8");
  } catch {
    console.error(`Error: cannot read file: ${resolved}`);
    process.exit(1);
  }
  db.exec(sql);
  // Report what was loaded
  const items = db.prepare("SELECT count(*) AS count FROM work_items").get() as { count: number };
  const edges = db.prepare("SELECT count(*) AS count FROM edges").get() as { count: number };
  console.log(
    `Seed applied.\n  work_items: ${items.count}\n  edges:      ${edges.count}`
  );
}

function cmdFrontier(db: Database): void {
  const rows = db.prepare(`
    SELECT w.id, w.name, w.kind, w.repo, w.scope_hint
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
  `).all() as { id: string; name: string; kind: string; repo: string | null; scope_hint: string | null }[];

  if (rows.length === 0) {
    console.log("No dispatchable work items.");
    return;
  }

  console.log(`Frontier: ${rows.length} dispatchable item(s)\n`);
  console.log(
    `  ${pad("ID", 20)} ${pad("KIND", 12)} ${pad("REPO", 24)} NAME`
  );
  console.log(`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(24)} ${"─".repeat(30)}`);
  for (const row of rows) {
    console.log(
      `  ${pad(row.id, 20)} ${pad(row.kind, 12)} ${pad(row.repo ?? "-", 24)} ${row.name}`
    );
  }
}

function cmdDone(db: Database, args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("Error: done requires a work item id.\n  manifest done <id>");
    process.exit(1);
  }

  const existing = db.prepare(
    "SELECT id, state FROM work_items WHERE id = ?"
  ).get(id) as { id: string; state: string } | undefined;

  if (!existing) {
    console.error(`Error: work item '${id}' not found.`);
    process.exit(1);
  }
  if (existing.state === "done") {
    console.log(`Work item '${id}' is already done.`);
    return;
  }

  db.prepare(
    "UPDATE work_items SET state = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(id);
  console.log(`Marked '${id}' as done.\n`);

  cmdFrontier(db);
}

function cmdStatus(db: Database): void {
  const summary = db.prepare(
    "SELECT state, count(*) AS count FROM work_items GROUP BY state ORDER BY state"
  ).all() as { state: string; count: number }[];

  let total = 0;
  const byState: Record<string, number> = {};
  for (const row of summary) {
    byState[row.state] = row.count;
    total += row.count;
  }

  console.log("Overall Status\n");
  console.log(`  Total items: ${total}`);
  for (const s of ["planned", "in_progress", "done", "deferred", "cancelled"]) {
    if (byState[s]) {
      console.log(`  ${pad(s, 14)} ${byState[s]}`);
    }
  }

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

  if (rollup.length > 0) {
    console.log(`\nPhase / Track Rollup\n`);
    console.log(
      `  ${pad("NAME", 44)} ${pad("DONE", 6)} ${pad("TOTAL", 6)} PROGRESS`
    );
    console.log(
      `  ${"─".repeat(44)} ${"─".repeat(6)} ${"─".repeat(6)} ${"─".repeat(8)}`
    );
    for (const row of rollup) {
      console.log(
        `  ${pad(row.name, 44)} ${pad(String(row.done_items), 6)} ${pad(String(row.total_items), 6)} ${pct(row.done_items, row.total_items)}`
      );
    }
  }
}

// ── Check subcommands ───────────────────────────────────────────────

function cmdCheckSuperseded(db: Database): void {
  const sqlPath = resolve(__dirname, "queries", "superseded.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const rows = db.prepare(sql).all() as {
    older_id: string;
    older_name: string;
    older_scope: string | null;
    newer_id: string;
    newer_name: string;
    newer_scope: string | null;
    shared_files: string;
  }[];

  if (rows.length === 0) {
    console.log("No superseded in_progress items detected.");
    return;
  }

  console.log(`Supersession Check: ${rows.length} potential supersession(s)\n`);
  console.log(
    `  ${pad("OLDER ITEM", 20)} ${pad("NEWER ITEM", 20)} SHARED FILES`
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(40)}`
  );
  for (const row of rows) {
    const files = parseJsonArray(row.shared_files);
    const display = files.length > 0 ? files.join(", ") : "(scope match)";
    console.log(`  ${pad(row.older_id, 20)} ${pad(row.newer_id, 20)} ${display}`);
    console.log(`    ${row.older_name}`);
    console.log(`    -> ${row.newer_name}`);
    console.log();
  }
}

function cmdCheckReconcile(db: Database): void {
  const sqlPath = resolve(__dirname, "queries", "reconcile.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const rows = db.prepare(sql).all() as {
    id: string;
    name: string;
    predicted_files: string;
    actual_files: string;
    hits: string;
    misses: string;
    false_positives: string;
  }[];

  if (rows.length === 0) {
    console.log("No completed items with both predicted and actual files. Reconciliation skipped.");
    return;
  }

  console.log(`Reconciliation: ${rows.length} item(s)\n`);

  let totalHits = 0;
  let totalMisses = 0;
  let totalFP = 0;

  for (const row of rows) {
    const predicted = parseJsonArray(row.predicted_files);
    const actual = parseJsonArray(row.actual_files);
    const hits = parseJsonArray(row.hits);
    const misses = parseJsonArray(row.misses);
    const fp = parseJsonArray(row.false_positives);
    const h = hits.length;
    const m = misses.length;
    const fpLen = fp.length;
    const denom = h + m + fpLen;
    const accuracy = denom === 0 ? 100 : Math.round((h / denom) * 100);

    totalHits += h;
    totalMisses += m;
    totalFP += fpLen;

    console.log(`  ${row.id}: ${row.name}`);
    console.log(`    Predicted: ${predicted.length} files`);
    console.log(`    Actual:    ${actual.length} files`);
    console.log(`    Hits:      ${h}  Misses: ${m}  False pos: ${fpLen}  Accuracy: ${accuracy}%`);
    if (m > 0) console.log(`    Missed:    ${misses.join(", ")}`);
    if (fpLen > 0) console.log(`    False pos: ${fp.join(", ")}`);
    console.log();

    // Store reconciliation in meta
    db.prepare(
      `UPDATE work_items
       SET meta = json_set(
         meta,
         '$.reconciliation',
         json(?)
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      JSON.stringify({
        hits,
        misses,
        false_positives: fp,
        accuracy: denom === 0 ? 1.0 : h / denom,
        checked_at: new Date().toISOString(),
      }),
      row.id
    );
  }

  const totalDenom = totalHits + totalMisses + totalFP;
  const overallAccuracy = totalDenom === 0 ? 100 : Math.round((totalHits / totalDenom) * 100);
  console.log(`  Overall: ${totalHits} hits, ${totalMisses} misses, ${totalFP} false positives — ${overallAccuracy}% accuracy`);
}

function cmdCheckOverlap(db: Database): void {
  const sqlPath = resolve(__dirname, "queries", "overlap.sql");
  const sql = readFileSync(sqlPath, "utf-8");
  const rows = db.prepare(sql).all() as {
    node_a: string;
    node_b: string;
    shared_files: string;
  }[];

  const frontierCount = db.prepare(`
    SELECT count(*) AS count
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
  `).get() as { count: number };

  console.log(`File Overlap Analysis (current frontier)\n`);
  console.log(`  Frontier items: ${frontierCount.count}`);

  if (rows.length === 0) {
    console.log("  No overlapping file sets detected.");
    return;
  }

  console.log(`  Overlapping pairs: ${rows.length}\n`);
  console.log(
    `  ${pad("ITEM A", 20)} ${pad("ITEM B", 20)} SHARED FILES`
  );
  console.log(
    `  ${"─".repeat(20)} ${"─".repeat(20)} ${"─".repeat(40)}`
  );
  for (const row of rows) {
    const files = parseJsonArray(row.shared_files);
    console.log(
      `  ${pad(row.node_a, 20)} ${pad(row.node_b, 20)} ${files.join(", ")}`
    );
  }
}

function cmdCheckDrift(db: Database): void {
  const rows = db.prepare(`
    SELECT id, json_extract(meta, '$.reconciliation.misses') AS misses
    FROM work_items
    WHERE json_extract(meta, '$.reconciliation.misses') IS NOT NULL
      AND json_array_length(json_extract(meta, '$.reconciliation.misses')) > 0
  `).all() as { id: string; misses: string }[];

  if (rows.length === 0) {
    console.log("No reconciliation data available for drift analysis.");
    console.log("Run 'manifest check reconcile' first on items with actual_files.");
    return;
  }

  const fileMissCounts: Record<string, string[]> = {};
  for (const row of rows) {
    const misses = parseJsonArray(row.misses);
    for (const file of misses) {
      if (!fileMissCounts[file]) fileMissCounts[file] = [];
      fileMissCounts[file].push(row.id);
    }
  }

  const driftFiles = Object.entries(fileMissCounts)
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  console.log("Drift Analysis\n");

  if (driftFiles.length === 0) {
    console.log("  No repeated drift patterns detected (need 2+ misses for same file).");
    console.log(`  Reconciliation data available for ${rows.length} item(s).`);
    return;
  }

  console.log(`  Frequently missed files (appeared in 2+ reconciliation misses):\n`);
  for (const [file, ids] of driftFiles) {
    console.log(`    ${file}: missed in ${ids.length} items (${ids.join(", ")})`);
  }

  const affectedItems = new Set<string>();
  const driftFileList = driftFiles.map(([f]) => f);
  for (const [, ids] of driftFiles) {
    for (const id of ids) affectedItems.add(id);
  }

  for (const id of affectedItems) {
    db.prepare(
      `UPDATE work_items
       SET meta = json_set(
         meta,
         '$.drift_patterns',
         json(?)
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = ?`
    ).run(
      JSON.stringify({
        files: driftFileList,
        frequency: driftFiles.reduce((sum, [, ids]) =>
          ids.includes(id) ? sum + 1 : sum, 0),
        recorded_at: new Date().toISOString(),
      }),
      id
    );
  }

  console.log(`\n  Drift patterns recorded on ${affectedItems.size} item(s).`);
}

function cmdCheckNewIssues(db: Database): void {
  const rows = db.prepare(`
    SELECT repo, issue_number
    FROM work_items
    WHERE issue_number IS NOT NULL AND repo IS NOT NULL
    ORDER BY repo, issue_number
  `).all() as { repo: string; issue_number: number }[];

  if (rows.length === 0) {
    console.log("No issues in manifest. Run manifest-bootstrap first.");
    return;
  }

  const byRepo: Record<string, number[]> = {};
  for (const row of rows) {
    if (!byRepo[row.repo]) byRepo[row.repo] = [];
    byRepo[row.repo].push(row.issue_number);
  }

  console.log("Manifest Issue Numbers (for diffing against GitHub):\n");
  for (const [repo, numbers] of Object.entries(byRepo)) {
    console.log(`  ${repo}: ${numbers.join(", ")}`);
  }
  console.log(`\n  Total: ${rows.length} issue(s) across ${Object.keys(byRepo).length} repo(s)`);
}

function cmdCheck(db: Database, args: string[]): void {
  const sub = args[0];

  if (!sub) {
    console.log("=== Supersession Check ===\n");
    cmdCheckSuperseded(db);
    console.log("\n=== Reconciliation ===\n");
    cmdCheckReconcile(db);
    console.log("\n=== Overlap Analysis ===\n");
    cmdCheckOverlap(db);
    console.log("\n=== Drift Analysis ===\n");
    cmdCheckDrift(db);
    return;
  }

  switch (sub) {
    case "superseded":
      cmdCheckSuperseded(db);
      break;
    case "reconcile":
      cmdCheckReconcile(db);
      break;
    case "overlap":
      cmdCheckOverlap(db);
      break;
    case "drift":
      cmdCheckDrift(db);
      break;
    case "new-issues":
      cmdCheckNewIssues(db);
      break;
    default:
      console.error(`Unknown check subcommand: ${sub}`);
      console.error("Available: superseded, reconcile, overlap, drift, new-issues");
      process.exit(1);
  }
}

function cmdQuery(db: Database, args: string[]): void {
  const sql = args[0];
  if (!sql) {
    console.error("Error: query requires a SQL string.\n  manifest query \"SELECT ...\"");
    process.exit(1);
  }
  const rows = db.prepare(sql).all() as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log("(0 rows)");
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "NULL").length))
  );
  console.log(cols.map((c, i) => pad(c, widths[i])).join("  "));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(cols.map((c, i) => pad(String(row[c] ?? "NULL"), widths[i])).join("  "));
  }
  console.log(`\n(${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

function cmdInProgress(db: Database, args: string[]): void {
  const id = args[0];
  const branch = args[1];
  if (!id || !branch) {
    console.error("Error: in-progress requires id and branch.\n  manifest in-progress <id> <branch>");
    process.exit(1);
  }

  const existing = db.prepare(
    "SELECT id, state FROM work_items WHERE id = ?"
  ).get(id) as { id: string; state: string } | undefined;

  if (!existing) {
    console.error(`Error: work item '${id}' not found.`);
    process.exit(1);
  }
  if (existing.state === "in_progress") {
    console.log(`Work item '${id}' is already in_progress.`);
    return;
  }

  db.prepare(
    "UPDATE work_items SET state = 'in_progress', branch = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
  ).run(branch, id);
  console.log(`Marked '${id}' as in_progress on branch '${branch}'.`);
}

function cmdPlan(db: Database): void {
  const plan = buildDispatchPlan(db);
  console.log(formatPlan(plan));
}

// ── Main ─────────────────────────────────────────────────────────────

function main(): void {
  const rawArgs = process.argv.slice(2);

  // Parse --data-dir flag
  let dataDir: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--data-dir") {
      dataDir = rawArgs[++i];
      if (!dataDir) {
        console.error("Error: --data-dir requires a path argument.");
        process.exit(1);
      }
    } else {
      args.push(rawArgs[i]);
    }
  }

  const command = args[0];
  if (!command) usage();

  const db = initManifest(dataDir);

  try {
    switch (command) {
      case "seed":
        cmdSeed(db, args.slice(1));
        break;
      case "frontier":
        cmdFrontier(db);
        break;
      case "done":
        cmdDone(db, args.slice(1));
        break;
      case "status":
        cmdStatus(db);
        break;
      case "check":
        cmdCheck(db, args.slice(1));
        break;
      case "plan":
        cmdPlan(db);
        break;
      case "query":
        cmdQuery(db, args.slice(1));
        break;
      case "in-progress":
        cmdInProgress(db, args.slice(1));
        break;
      default:
        console.error(`Unknown command: ${command}\n`);
        usage();
    }
  } finally {
    db.close();
  }
}

main();
