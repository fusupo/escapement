import { PGlite } from "@electric-sql/pglite";
import { applySchema } from "./init.ts";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadQuery(name: string): string {
  return readFileSync(resolve(__dirname, "queries", `${name}.sql`), "utf-8");
}

async function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
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
async function seed(db: PGlite) {
  await db.exec(`
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
        ARRAY['manifest/schema.sql', 'manifest/init.ts'],
        ARRAY['manifest/schema.sql', 'manifest/init.ts'],
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'esc#11', 'Core queries', 'issue', 'planned',
        'escapement', 11,
        'https://github.com/fusupo/escapement/issues/11',
        NULL, NULL,
        ARRAY['manifest/queries/frontier.sql', 'manifest/queries/overlap.sql', 'shared/utils.ts'],
        '{}',
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'esc#12', 'Bootstrap CLI', 'issue', 'planned',
        'escapement', 12,
        'https://github.com/fusupo/escapement/issues/12',
        NULL, NULL,
        ARRAY['manifest/bootstrap.ts'],
        '{}',
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'esc#13', 'UI components', 'issue', 'planned',
        'escapement', 13,
        'https://github.com/fusupo/escapement/issues/13',
        NULL, NULL,
        ARRAY['src/components/Dashboard.tsx', 'shared/utils.ts'],
        '{}',
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
      ),
      (
        'esc#14', 'Design review', 'issue', 'planned',
        'escapement', 14,
        'https://github.com/fusupo/escapement/issues/14',
        NULL, NULL,
        ARRAY['docs/design.md'],
        '{}',
        '{"bootstrap_status":"active","needs_human":true}'::jsonb
      ),
      (
        'esc#15', 'Deprecate construct', 'capability', 'planned',
        'escapement', NULL, NULL,
        NULL, NULL,
        '{}',
        '{}',
        '{"bootstrap_status":"active","needs_human":false}'::jsonb
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

async function run() {
  console.log("Manifest query tests\n");

  // Setup: in-memory PGlite with schema and seed data
  console.log("0. Setup");
  const db = await PGlite.create("memory://");
  await applySchema(db);
  await seed(db);
  console.log("  \u2713 Schema applied and data seeded\n");

  // ─── 1. Frontier Query ───────────────────────────────────────────
  console.log("1. Frontier query (frontier.sql)");
  const frontierSql = loadQuery("frontier");
  const frontier = await db.query<{
    id: string; name: string; kind: string;
    repo: string | null; scope_hint: string | null;
    predicted_files: string[];
  }>(frontierSql);

  const frontierIds = frontier.rows.map((r) => r.id).sort();

  // esc#11: planned, depends_on esc#10 (done) -> dispatchable
  await assert(frontierIds.includes("esc#11"), "esc#11 is on the frontier (dep met)");

  // esc#13: planned, no deps -> dispatchable
  await assert(frontierIds.includes("esc#13"), "esc#13 is on the frontier (no deps)");

  // esc#15: planned capability, no deps -> dispatchable
  await assert(frontierIds.includes("esc#15"), "esc#15 capability is on the frontier");

  // esc#10: done -> not on frontier
  await assert(!frontierIds.includes("esc#10"), "esc#10 excluded (done)");

  // esc#12: depends_on esc#13 (planned, not done) -> blocked
  await assert(!frontierIds.includes("esc#12"), "esc#12 excluded (unmet dep on esc#13)");

  // esc#14: needs_human=true -> not dispatchable
  await assert(!frontierIds.includes("esc#14"), "esc#14 excluded (needs_human gate)");

  await assert(frontierIds.length === 3, `Frontier has 3 items (got ${frontierIds.length})`);

  // ─── 2. Overlap Query ────────────────────────────────────────────
  console.log("\n2. Overlap query (overlap.sql)");
  const overlapSql = loadQuery("overlap");
  const overlap = await db.query<{
    node_a: string; node_b: string; shared_files: string[];
  }>(overlapSql);

  await assert(overlap.rows.length === 1, `Found 1 overlap pair (got ${overlap.rows.length})`);

  const pair = overlap.rows[0];
  const pairIds = [pair.node_a, pair.node_b].sort();
  await assert(
    pairIds[0] === "esc#11" && pairIds[1] === "esc#13",
    `Overlap pair is esc#11 + esc#13 (got ${pairIds.join(" + ")})`
  );
  await assert(
    pair.shared_files.length === 1 && pair.shared_files[0] === "shared/utils.ts",
    `Shared file is shared/utils.ts (got ${JSON.stringify(pair.shared_files)})`
  );

  // ─── 3. Dependencies Query ───────────────────────────────────────
  console.log("\n3. Dependencies query (dependencies.sql)");
  const depsSql = loadQuery("dependencies");

  // esc#11 depends_on esc#10
  const deps11 = await db.query<{ id: string; name: string; state: string }>(
    depsSql, ["esc#11"]
  );
  await assert(deps11.rows.length === 1, "esc#11 has 1 dependency");
  await assert(deps11.rows[0].id === "esc#10", "esc#11 depends on esc#10");
  await assert(deps11.rows[0].state === "done", "esc#10 state is done");

  // esc#12 depends_on esc#13
  const deps12 = await db.query<{ id: string; name: string; state: string }>(
    depsSql, ["esc#12"]
  );
  await assert(deps12.rows.length === 1, "esc#12 has 1 dependency");
  await assert(deps12.rows[0].id === "esc#13", "esc#12 depends on esc#13");
  await assert(deps12.rows[0].state === "planned", "esc#13 state is planned (blocking)");

  // esc#13 has no deps
  const deps13 = await db.query<{ id: string; name: string; state: string }>(
    depsSql, ["esc#13"]
  );
  await assert(deps13.rows.length === 0, "esc#13 has no dependencies");

  // ─── 4. Progress Query ───────────────────────────────────────────
  console.log("\n4. Progress query (progress.sql)");
  const progressSql = loadQuery("progress");
  const progress = await db.query<{
    name: string; total_items: string; done_items: string;
  }>(progressSql);

  // Build a lookup by name
  const byName = new Map(progress.rows.map((r) => [r.name, r]));

  // Core Track: esc#10 (done), esc#11 (planned), esc#12 (planned) -> 3 total, 1 done
  const core = byName.get("Core Track");
  await assert(core !== undefined, "Core Track appears in progress");
  await assert(Number(core!.total_items) === 3, `Core Track total=3 (got ${core!.total_items})`);
  await assert(Number(core!.done_items) === 1, `Core Track done=1 (got ${core!.done_items})`);

  // UI Track: esc#13 (planned), esc#14 (planned) -> 2 total, 0 done
  const ui = byName.get("UI Track");
  await assert(ui !== undefined, "UI Track appears in progress");
  await assert(Number(ui!.total_items) === 2, `UI Track total=2 (got ${ui!.total_items})`);
  await assert(Number(ui!.done_items) === 0, `UI Track done=0 (got ${ui!.done_items})`);

  // Phase Alpha: all 5 issues (recursive through tracks) -> 5 total, 1 done
  const phase = byName.get("Phase Alpha");
  await assert(phase !== undefined, "Phase Alpha appears in progress");
  await assert(Number(phase!.total_items) === 5, `Phase Alpha total=5 (got ${phase!.total_items})`);
  await assert(Number(phase!.done_items) === 1, `Phase Alpha done=1 (got ${phase!.done_items})`);

  // ─── 5. Provenance Query ─────────────────────────────────────────
  console.log("\n5. Provenance query (provenance.sql)");
  const provSql = loadQuery("provenance");

  // esc#10 is done with archive_path set
  const prov10 = await db.query<{
    id: string; name: string; branch: string; archive_path: string;
  }>(provSql, ["esc#10"]);
  await assert(prov10.rows.length === 1, "esc#10 has provenance");
  await assert(
    prov10.rows[0].archive_path === "../escapement-ctx/10-schema-setup/archive",
    `Correct archive path (got ${prov10.rows[0].archive_path})`
  );
  await assert(prov10.rows[0].branch === "10-schema-setup", "Correct branch");

  // esc#11 has no archive_path (not done)
  const prov11 = await db.query<{
    id: string; name: string; branch: string; archive_path: string;
  }>(provSql, ["esc#11"]);
  await assert(prov11.rows.length === 0, "esc#11 has no provenance (not archived)");

  // ─── Done ────────────────────────────────────────────────────────
  console.log("\n\u2705 All query tests passed!\n");
  await db.close();
}

run().catch((e) => {
  console.error("\n\u274c Test failed:", e.message);
  process.exit(1);
});
