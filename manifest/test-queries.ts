import Database from "better-sqlite3";
import { applySchema } from "./init.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadQuery(name: string): string {
  return readFileSync(resolve(__dirname, "queries", `${name}.sql`), "utf-8");
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v === "string") return JSON.parse(v);
  if (Array.isArray(v)) return v;
  return [];
}

/**
 * Seed the database with a representative graph:
 *
 *   phase:alpha
 *     track:alpha:core
 *       esc#10  (done, archived)
 *       esc#11  (planned, depends_on esc#10 -- met, so dispatchable)
 *       esc#12  (planned, depends_on esc#13 -- unmet, so blocked)
 *     track:alpha:ui
 *       esc#13  (planned, no deps -- dispatchable)
 *       esc#14  (planned, needs_human gate -- not dispatchable)
 *
 *   esc#11 and esc#13 share predicted files (overlap pair)
 *   esc#15  (planned, capability, no deps, no files -- dispatchable but no overlap)
 */
function seed(db: Database.Database) {
  db.exec(`
    INSERT INTO work_items (id, name, kind, state) VALUES
      ('phase:alpha', 'Phase Alpha', 'phase', 'planned'),
      ('track:alpha:core', 'Core Track', 'track', 'planned'),
      ('track:alpha:ui', 'UI Track', 'track', 'planned');

    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      branch, archive_path, predicted_files, actual_files, meta
    ) VALUES
      (
        'esc#10', 'Schema setup', 'issue', 'done',
        'escapement', 10,
        'https://github.com/fusupo/escapement/issues/10',
        '10-schema-setup',
        '../escapement-ctx/10-schema-setup/archive',
        '["manifest/schema.sql", "manifest/init.ts"]',
        '["manifest/schema.sql", "manifest/init.ts"]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'esc#11', 'Core queries', 'issue', 'planned',
        'escapement', 11,
        'https://github.com/fusupo/escapement/issues/11',
        NULL, NULL,
        '["manifest/queries/frontier.sql", "manifest/queries/overlap.sql", "shared/utils.ts"]',
        '[]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'esc#12', 'Bootstrap CLI', 'issue', 'planned',
        'escapement', 12,
        'https://github.com/fusupo/escapement/issues/12',
        NULL, NULL,
        '["manifest/bootstrap.ts"]',
        '[]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'esc#13', 'UI components', 'issue', 'planned',
        'escapement', 13,
        'https://github.com/fusupo/escapement/issues/13',
        NULL, NULL,
        '["src/components/Dashboard.tsx", "shared/utils.ts"]',
        '[]',
        '{"bootstrap_status":"active","needs_human":false}'
      ),
      (
        'esc#14', 'Design review', 'issue', 'planned',
        'escapement', 14,
        'https://github.com/fusupo/escapement/issues/14',
        NULL, NULL,
        '["docs/design.md"]',
        '[]',
        '{"bootstrap_status":"active","needs_human":true}'
      ),
      (
        'esc#15', 'Deprecate construct', 'capability', 'planned',
        'escapement', NULL, NULL,
        NULL, NULL,
        '[]',
        '[]',
        '{"bootstrap_status":"active","needs_human":false}'
      );

    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('track:alpha:core', 'is_part_of', 'phase:alpha', 'certain'),
      ('track:alpha:ui',   'is_part_of', 'phase:alpha', 'certain'),
      ('esc#10', 'is_part_of', 'track:alpha:core', 'certain'),
      ('esc#11', 'is_part_of', 'track:alpha:core', 'certain'),
      ('esc#12', 'is_part_of', 'track:alpha:core', 'certain'),
      ('esc#13', 'is_part_of', 'track:alpha:ui',   'certain'),
      ('esc#14', 'is_part_of', 'track:alpha:ui',   'certain'),
      ('esc#11', 'depends_on', 'esc#10', 'certain'),
      ('esc#12', 'depends_on', 'esc#13', 'certain');
  `);
}

function run() {
  console.log("Manifest query tests\n");

  // Setup: in-memory SQLite with schema and seed data
  console.log("0. Setup");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seed(db);
  console.log("  \u2713 Schema applied and data seeded\n");

  // ─── 1. Frontier Query ───────────────────────────────────────────
  console.log("1. Frontier query (frontier.sql)");
  const frontierSql = loadQuery("frontier");
  const frontier = db.prepare(frontierSql).all() as {
    id: string; name: string; kind: string;
    repo: string | null; scope_hint: string | null;
    predicted_files: string;
  }[];

  const frontierIds = frontier.map((r) => r.id).sort();

  // esc#11: planned, depends_on esc#10 (done) -> dispatchable
  assert(frontierIds.includes("esc#11"), "esc#11 is on the frontier (dep met)");

  // esc#13: planned, no deps -> dispatchable
  assert(frontierIds.includes("esc#13"), "esc#13 is on the frontier (no deps)");

  // esc#15: planned capability, no deps -> dispatchable
  assert(frontierIds.includes("esc#15"), "esc#15 capability is on the frontier");

  // esc#10: done -> not on frontier
  assert(!frontierIds.includes("esc#10"), "esc#10 excluded (done)");

  // esc#12: depends_on esc#13 (planned, not done) -> blocked
  assert(!frontierIds.includes("esc#12"), "esc#12 excluded (unmet dep on esc#13)");

  // esc#14: needs_human=true -> not dispatchable
  assert(!frontierIds.includes("esc#14"), "esc#14 excluded (needs_human gate)");

  assert(frontierIds.length === 3, `Frontier has 3 items (got ${frontierIds.length})`);

  // ─── 2. Overlap Query ────────────────────────────────────────────
  console.log("\n2. Overlap query (overlap.sql)");
  const overlapSql = loadQuery("overlap");
  const overlap = db.prepare(overlapSql).all() as {
    node_a: string; node_b: string; shared_files: string;
  }[];

  assert(overlap.length === 1, `Found 1 overlap pair (got ${overlap.length})`);

  const pair = overlap[0];
  const pairIds = [pair.node_a, pair.node_b].sort();
  assert(
    pairIds[0] === "esc#11" && pairIds[1] === "esc#13",
    `Overlap pair is esc#11 + esc#13 (got ${pairIds.join(" + ")})`
  );
  const sharedFiles = parseJsonArray(pair.shared_files);
  assert(
    sharedFiles.length === 1 && sharedFiles[0] === "shared/utils.ts",
    `Shared file is shared/utils.ts (got ${JSON.stringify(sharedFiles)})`
  );

  // ─── 3. Dependencies Query ───────────────────────────────────────
  console.log("\n3. Dependencies query (dependencies.sql)");
  const depsSql = loadQuery("dependencies");

  // esc#11 depends_on esc#10
  const deps11 = db.prepare(depsSql).all("esc#11") as { id: string; name: string; state: string }[];
  assert(deps11.length === 1, "esc#11 has 1 dependency");
  assert(deps11[0].id === "esc#10", "esc#11 depends on esc#10");
  assert(deps11[0].state === "done", "esc#10 state is done");

  // esc#12 depends_on esc#13
  const deps12 = db.prepare(depsSql).all("esc#12") as { id: string; name: string; state: string }[];
  assert(deps12.length === 1, "esc#12 has 1 dependency");
  assert(deps12[0].id === "esc#13", "esc#12 depends on esc#13");
  assert(deps12[0].state === "planned", "esc#13 state is planned (blocking)");

  // esc#13 has no deps
  const deps13 = db.prepare(depsSql).all("esc#13") as { id: string; name: string; state: string }[];
  assert(deps13.length === 0, "esc#13 has no dependencies");

  // ─── 4. Progress Query ───────────────────────────────────────────
  console.log("\n4. Progress query (progress.sql)");
  const progressSql = loadQuery("progress");
  const progress = db.prepare(progressSql).all() as {
    name: string; total_items: number; done_items: number;
  }[];

  // Build a lookup by name
  const byName = new Map(progress.map((r) => [r.name, r]));

  // Core Track: esc#10 (done), esc#11 (planned), esc#12 (planned) -> 3 total, 1 done
  const core = byName.get("Core Track");
  assert(core !== undefined, "Core Track appears in progress");
  assert(core!.total_items === 3, `Core Track total=3 (got ${core!.total_items})`);
  assert(core!.done_items === 1, `Core Track done=1 (got ${core!.done_items})`);

  // UI Track: esc#13 (planned), esc#14 (planned) -> 2 total, 0 done
  const ui = byName.get("UI Track");
  assert(ui !== undefined, "UI Track appears in progress");
  assert(ui!.total_items === 2, `UI Track total=2 (got ${ui!.total_items})`);
  assert(ui!.done_items === 0, `UI Track done=0 (got ${ui!.done_items})`);

  // Phase Alpha: all 5 issues (recursive through tracks) -> 5 total, 1 done
  const phase = byName.get("Phase Alpha");
  assert(phase !== undefined, "Phase Alpha appears in progress");
  assert(phase!.total_items === 5, `Phase Alpha total=5 (got ${phase!.total_items})`);
  assert(phase!.done_items === 1, `Phase Alpha done=1 (got ${phase!.done_items})`);

  // ─── 5. Provenance Query ─────────────────────────────────────────
  console.log("\n5. Provenance query (provenance.sql)");
  const provSql = loadQuery("provenance");

  // esc#10 is done with archive_path set
  const prov10 = db.prepare(provSql).all("esc#10") as {
    id: string; name: string; branch: string; archive_path: string;
  }[];
  assert(prov10.length === 1, "esc#10 has provenance");
  assert(
    prov10[0].archive_path === "../escapement-ctx/10-schema-setup/archive",
    `Correct archive path (got ${prov10[0].archive_path})`
  );
  assert(prov10[0].branch === "10-schema-setup", "Correct branch");

  // esc#11 has no archive_path (not done)
  const prov11 = db.prepare(provSql).all("esc#11") as {
    id: string; name: string; branch: string; archive_path: string;
  }[];
  assert(prov11.length === 0, "esc#11 has no provenance (not archived)");

  // ─── Done ────────────────────────────────────────────────────────
  console.log("\n\u2705 All query tests passed!\n");
  db.close();
}

try {
  run();
} catch (e: any) {
  console.error("\n\u274c Test failed:", e.message);
  process.exit(1);
}
