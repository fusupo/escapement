/**
 * seed.ts -- Self-seed the manifest with its own development tasks.
 *
 * The manifest system's implementation becomes the first managed project.
 * This populates work_items and edges for issues m#1 through m#9,
 * along with phase and track hierarchy entities.
 *
 * Usage:
 *   node --import tsx manifest/seed.ts          # seed real SQLite DB
 *   import { seed } from "./seed.ts"            # programmatic use
 */

import type { Database } from "better-sqlite3";
import { initManifest } from "./init.ts";

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

interface WorkItem {
  id: string;
  name: string;
  kind: "issue" | "capability" | "phase" | "track";
  state: "planned" | "in_progress" | "done" | "deferred" | "cancelled";
  repo?: string;
  issue_number?: number;
  issue_url?: string;
  predicted_files?: string[];
  meta?: Record<string, unknown>;
}

interface Edge {
  from_id: string;
  rel: "depends_on" | "is_part_of" | "implemented_by";
  to_id: string;
  confidence?: "certain" | "inferred" | "ambiguous";
}

const REPO = "fusupo/escapement";
const issueUrl = (n: number) =>
  `https://github.com/${REPO}/issues/${n}`;

// -- Phase ------------------------------------------------------------------

const phase: WorkItem = {
  id: "phase:manifest",
  name: "Manifest System V2",
  kind: "phase",
  state: "in_progress",
};

// -- Tracks -----------------------------------------------------------------

const tracks: WorkItem[] = [
  {
    id: "track:foundation",
    name: "Foundation",
    kind: "track",
    state: "in_progress",
  },
  {
    id: "track:planning",
    name: "Planning",
    kind: "track",
    state: "planned",
  },
  {
    id: "track:dispatch",
    name: "Dispatch",
    kind: "track",
    state: "planned",
  },
];

// -- Issues (m#1 through m#9) -----------------------------------------------

const issues: WorkItem[] = [
  {
    id: "m#1",
    name: "PGlite schema setup",
    kind: "issue",
    state: "done",
    repo: REPO,
    issue_number: 33,
    issue_url: issueUrl(33),
    predicted_files: [
      "manifest/schema.sql",
      "manifest/init.ts",
      "manifest/test-schema.ts",
      "manifest/package.json",
      "manifest/tsconfig.json",
    ],
  },
  {
    id: "m#2",
    name: "Core SQL queries",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 34,
    issue_url: issueUrl(34),
    predicted_files: [
      "manifest/queries/frontier.sql",
      "manifest/queries/overlap.sql",
      "manifest/queries/dependencies.sql",
      "manifest/queries/progress.sql",
      "manifest/queries/provenance.sql",
    ],
  },
  {
    id: "m#3",
    name: "CLI wrapper",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 35,
    issue_url: issueUrl(35),
    predicted_files: ["manifest/manifest-cli.ts"],
  },
  {
    id: "m#4",
    name: "Self-seed with manifest development tasks",
    kind: "issue",
    state: "in_progress",
    repo: REPO,
    issue_number: 36,
    issue_url: issueUrl(36),
    predicted_files: ["manifest/seed.ts", "manifest/test-seed.ts"],
  },
  {
    id: "m#5",
    name: "manifest-bootstrap skill",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 37,
    issue_url: issueUrl(37),
    predicted_files: ["skills/manifest-bootstrap/SKILL.md"],
  },
  {
    id: "m#6",
    name: "manifest-plan skill",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 38,
    issue_url: issueUrl(38),
    predicted_files: ["skills/manifest-plan/SKILL.md"],
  },
  {
    id: "m#7",
    name: "manifest-sync skill",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 39,
    issue_url: issueUrl(39),
    predicted_files: ["skills/manifest-sync/SKILL.md"],
  },
  {
    id: "m#8",
    name: "manifest-check skill",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 40,
    issue_url: issueUrl(40),
    predicted_files: ["skills/manifest-check/SKILL.md"],
  },
  {
    id: "m#9",
    name: "manifest-dispatch skill",
    kind: "issue",
    state: "planned",
    repo: REPO,
    issue_number: 41,
    issue_url: issueUrl(41),
    predicted_files: ["skills/manifest-dispatch/SKILL.md"],
  },
];

// -- Dependency edges -------------------------------------------------------
// These encode the actual dependency graph from the issue breakdown.

const dependencyEdges: Edge[] = [
  // m#2, m#3, m#4 all depend on m#1 (schema)
  { from_id: "m#2", rel: "depends_on", to_id: "m#1" },
  { from_id: "m#3", rel: "depends_on", to_id: "m#1" },
  { from_id: "m#4", rel: "depends_on", to_id: "m#1" },

  // m#5 depends on m#2 (queries) and m#3 (CLI)
  { from_id: "m#5", rel: "depends_on", to_id: "m#2" },
  { from_id: "m#5", rel: "depends_on", to_id: "m#3" },

  // m#6, m#7, m#8 depend on m#5 (bootstrap)
  { from_id: "m#6", rel: "depends_on", to_id: "m#5" },
  { from_id: "m#7", rel: "depends_on", to_id: "m#5" },
  { from_id: "m#8", rel: "depends_on", to_id: "m#5" },

  // m#9 depends on m#6 (plan) and m#7 (sync)
  { from_id: "m#9", rel: "depends_on", to_id: "m#6" },
  { from_id: "m#9", rel: "depends_on", to_id: "m#7" },
];

// -- Hierarchy edges --------------------------------------------------------

const hierarchyEdges: Edge[] = [
  // Tracks belong to phase
  { from_id: "track:foundation", rel: "is_part_of", to_id: "phase:manifest" },
  { from_id: "track:planning", rel: "is_part_of", to_id: "phase:manifest" },
  { from_id: "track:dispatch", rel: "is_part_of", to_id: "phase:manifest" },

  // Foundation track: m#1, m#2, m#3, m#4
  { from_id: "m#1", rel: "is_part_of", to_id: "track:foundation" },
  { from_id: "m#2", rel: "is_part_of", to_id: "track:foundation" },
  { from_id: "m#3", rel: "is_part_of", to_id: "track:foundation" },
  { from_id: "m#4", rel: "is_part_of", to_id: "track:foundation" },

  // Planning track: m#5, m#6, m#7, m#8
  { from_id: "m#5", rel: "is_part_of", to_id: "track:planning" },
  { from_id: "m#6", rel: "is_part_of", to_id: "track:planning" },
  { from_id: "m#7", rel: "is_part_of", to_id: "track:planning" },
  { from_id: "m#8", rel: "is_part_of", to_id: "track:planning" },

  // Dispatch track: m#9
  { from_id: "m#9", rel: "is_part_of", to_id: "track:dispatch" },
];

// ---------------------------------------------------------------------------
// Seed function
// ---------------------------------------------------------------------------

/**
 * Insert all manifest work items and edges into the given SQLite instance.
 * Uses INSERT ... ON CONFLICT DO NOTHING for idempotency.
 */
export function seed(db: Database): {
  itemsInserted: number;
  edgesInserted: number;
} {
  const allItems: WorkItem[] = [phase, ...tracks, ...issues];
  const allEdges: Edge[] = [...dependencyEdges, ...hierarchyEdges];

  let itemsInserted = 0;
  let edgesInserted = 0;

  const insertItem = db.prepare(
    `INSERT INTO work_items (id, name, kind, state, repo, issue_number, issue_url, predicted_files, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`
  );

  const insertEdge = db.prepare(
    `INSERT INTO edges (from_id, rel, to_id, confidence)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (from_id, rel, to_id) DO NOTHING`
  );

  // Insert work items
  for (const item of allItems) {
    const result = insertItem.run(
      item.id,
      item.name,
      item.kind,
      item.state,
      item.repo ?? null,
      item.issue_number ?? null,
      item.issue_url ?? null,
      JSON.stringify(item.predicted_files ?? []),
      item.meta ? JSON.stringify(item.meta) : "{}",
    );
    if (result.changes > 0) {
      itemsInserted++;
    }
  }

  // Insert edges
  for (const edge of allEdges) {
    const result = insertEdge.run(
      edge.from_id,
      edge.rel,
      edge.to_id,
      edge.confidence ?? "certain",
    );
    if (result.changes > 0) {
      edgesInserted++;
    }
  }

  return { itemsInserted, edgesInserted };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1]?.endsWith("/seed.ts") ||
  process.argv[1]?.endsWith("/seed.js");

if (isMain) {
  const db = initManifest();
  const result = seed(db);
  console.log(
    `Manifest seeded: ${result.itemsInserted} work items, ${result.edgesInserted} edges`
  );
  db.close();
}
