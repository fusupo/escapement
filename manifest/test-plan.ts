/**
 * test-plan.ts -- Tests for the manifest dispatch planner.
 *
 * Uses the same in-memory SQLite + mock data pattern as test-queries.ts.
 * Verifies:
 *   1. queryFrontier returns correct items
 *   2. queryOverlaps detects shared files
 *   3. queryBlocked returns blocked items with blockers
 *   4. queryHumanGated returns gated items
 *   5. buildParallelGroups correctly groups items
 *   6. buildParallelGroups with assessments separates semantic conflicts
 *   7. determineMergeOrder works for additive files
 *   8. buildValidationPolicy produces reasonable defaults
 *   9. buildDispatchPlan assembles everything
 *  10. formatPlan produces readable output
 *  11. Multi-repo grouping partitions correctly
 */

import Database from "better-sqlite3";
import { applySchema } from "./init.ts";
import {
  queryFrontier,
  queryOverlaps,
  queryBlocked,
  queryHumanGated,
  buildParallelGroups,
  buildOverlapMap,
  computeOwnedFiles,
  computeForbiddenFiles,
  determineMergeOrder,
  buildValidationPolicy,
  buildDispatchPlan,
  formatPlan,
  overlapKey,
  type Assessment,
} from "./plan.ts";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

/**
 * Seed the database with a test graph:
 *
 *   Repo: escapement
 *     esc#10  (done)
 *     esc#11  (planned, depends_on esc#10 -- met, dispatchable)
 *     esc#12  (planned, depends_on esc#13 -- unmet, blocked)
 *     esc#13  (planned, no deps -- dispatchable)
 *     esc#14  (planned, needs_human -- gated)
 *     esc#15  (planned, capability, no deps -- dispatchable, no files)
 *
 *   Repo: other-repo
 *     other#1  (planned, no deps -- dispatchable)
 *
 *   esc#11 and esc#13 share 'shared/utils.ts'
 */
function seed(db: Database.Database) {
  db.exec(`
    INSERT INTO work_items (
      id, name, kind, state, repo, issue_number, issue_url,
      branch, predicted_files, meta
    ) VALUES
      (
        'esc#10', 'Schema setup', 'issue', 'done',
        'fusupo/escapement', 10,
        'https://github.com/fusupo/escapement/issues/10',
        '10-schema-setup',
        '["manifest/schema.sql", "manifest/init.ts"]',
        '{}'
      ),
      (
        'esc#11', 'Core queries', 'issue', 'planned',
        'fusupo/escapement', 11,
        'https://github.com/fusupo/escapement/issues/11',
        '11-core-queries',
        '["manifest/queries/frontier.sql", "shared/utils.ts"]',
        '{}'
      ),
      (
        'esc#12', 'Bootstrap CLI', 'issue', 'planned',
        'fusupo/escapement', 12,
        'https://github.com/fusupo/escapement/issues/12',
        NULL,
        '["manifest/bootstrap.ts"]',
        '{}'
      ),
      (
        'esc#13', 'UI components', 'issue', 'planned',
        'fusupo/escapement', 13,
        'https://github.com/fusupo/escapement/issues/13',
        '13-ui-components',
        '["src/components/Dashboard.tsx", "shared/utils.ts"]',
        '{}'
      ),
      (
        'esc#14', 'Design review', 'issue', 'planned',
        'fusupo/escapement', 14,
        'https://github.com/fusupo/escapement/issues/14',
        NULL,
        '["docs/design.md"]',
        '{"needs_human":true}'
      ),
      (
        'esc#15', 'Deprecate construct', 'capability', 'planned',
        'fusupo/escapement', NULL, NULL,
        NULL,
        '[]',
        '{}'
      ),
      (
        'other#1', 'Other repo task', 'issue', 'planned',
        'fusupo/other-repo', 1,
        'https://github.com/fusupo/other-repo/issues/1',
        '1-other-task',
        '["src/main.ts", "shared/utils.ts"]',
        '{}'
      );

    INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
      ('esc#11', 'depends_on', 'esc#10', 'certain'),
      ('esc#12', 'depends_on', 'esc#13', 'certain');
  `);
}

function run() {
  console.log("Manifest plan tests\n");

  // Setup
  console.log("0. Setup");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seed(db);
  console.log("  \u2713 Schema applied and data seeded\n");

  // ─── 1. queryFrontier ─────────────────────────────────────────────
  console.log("1. queryFrontier");
  const frontier = queryFrontier(db);
  const frontierIds = frontier.map((f) => f.id).sort();

  assert(frontierIds.includes("esc#11"), "esc#11 on frontier (dep met)");
  assert(frontierIds.includes("esc#13"), "esc#13 on frontier (no deps)");
  assert(frontierIds.includes("esc#15"), "esc#15 on frontier (capability, no deps)");
  assert(frontierIds.includes("other#1"), "other#1 on frontier (different repo, no deps)");
  assert(!frontierIds.includes("esc#10"), "esc#10 excluded (done)");
  assert(!frontierIds.includes("esc#12"), "esc#12 excluded (blocked)");
  assert(!frontierIds.includes("esc#14"), "esc#14 excluded (human-gated)");
  assert(frontier.length === 4, `Frontier has 4 items (got ${frontier.length})`);

  // ─── 2. queryOverlaps ─────────────────────────────────────────────
  console.log("\n2. queryOverlaps");
  const overlaps = queryOverlaps(db);

  // esc#11 & esc#13 share shared/utils.ts (same repo)
  // esc#11 & other#1 share shared/utils.ts (cross-repo)
  // esc#13 & other#1 share shared/utils.ts (cross-repo)
  assert(overlaps.length === 3, `Found 3 overlap pairs (got ${overlaps.length})`);

  const escPair = overlaps.find((p) => {
    const ids = [p.node_a, p.node_b].sort();
    return ids[0] === "esc#11" && ids[1] === "esc#13";
  });
  assert(escPair !== undefined, "esc#11 + esc#13 overlap pair found");
  assert(
    escPair!.shared_files.includes("shared/utils.ts"),
    `Shared file is shared/utils.ts`
  );

  // ─── 3. queryBlocked ──────────────────────────────────────────────
  console.log("\n3. queryBlocked");
  const blocked = queryBlocked(db);

  assert(blocked.length === 1, `1 blocked item (got ${blocked.length})`);
  assert(blocked[0].id === "esc#12", "esc#12 is blocked");
  assert(blocked[0].blockers.length === 1, "esc#12 has 1 blocker");
  assert(blocked[0].blockers[0].id === "esc#13", "esc#12 blocked by esc#13");

  // ─── 4. queryHumanGated ───────────────────────────────────────────
  console.log("\n4. queryHumanGated");
  const humanGated = queryHumanGated(db);

  assert(humanGated.length === 1, `1 human-gated item (got ${humanGated.length})`);
  assert(humanGated[0].id === "esc#14", "esc#14 is human-gated");

  // ─── 5. buildParallelGroups (no assessments = conservative) ───────
  console.log("\n5. buildParallelGroups (default/conservative)");
  const groups = buildParallelGroups(frontier, overlaps);

  // Items from different repos should be in separate groups
  const escapementGroups = groups.filter((g) => g.repo === "fusupo/escapement");
  const otherGroups = groups.filter((g) => g.repo === "fusupo/other-repo");
  assert(otherGroups.length === 1, "other-repo has 1 group");
  assert(otherGroups[0].nodes.length === 1, "other-repo group has 1 node");

  // Without assessments, esc#11 and esc#13 overlap on shared/utils.ts
  // which defaults to 'unknown' -- they should be in separate groups
  const group11 = escapementGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#11")
  );
  const group13 = escapementGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#13")
  );
  assert(group11 !== undefined, "esc#11 assigned to a group");
  assert(group13 !== undefined, "esc#13 assigned to a group");

  // They should NOT be in the same group (unknown overlap)
  const sameGroup = group11 === group13;
  assert(!sameGroup, "esc#11 and esc#13 in SEPARATE groups (unknown overlap)");

  // esc#15 has no files, should be in any group without conflict
  const group15 = escapementGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#15")
  );
  assert(group15 !== undefined, "esc#15 assigned to a group");

  // ─── 6. buildParallelGroups (with trivial assessment) ─────────────
  console.log("\n6. buildParallelGroups (trivial assessment)");
  const trivialAssessments = new Map<string, Assessment>();
  trivialAssessments.set(
    overlapKey("esc#11", "esc#13", "shared/utils.ts"),
    "trivial"
  );

  const trivialGroups = buildParallelGroups(frontier, overlaps, trivialAssessments);
  const escTrivialGroups = trivialGroups.filter((g) => g.repo === "fusupo/escapement");

  // With trivial assessment, esc#11 and esc#13 CAN be in the same group
  const trivialGroup11 = escTrivialGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#11")
  );
  const trivialGroup13 = escTrivialGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#13")
  );
  const trivialSameGroup = trivialGroup11 === trivialGroup13;
  assert(trivialSameGroup, "esc#11 and esc#13 in SAME group (trivial overlap)");

  // ─── 7. buildParallelGroups (semantic assessment) ─────────────────
  console.log("\n7. buildParallelGroups (semantic assessment)");
  const semanticAssessments = new Map<string, Assessment>();
  semanticAssessments.set(
    overlapKey("esc#11", "esc#13", "shared/utils.ts"),
    "semantic"
  );

  const semanticGroups = buildParallelGroups(frontier, overlaps, semanticAssessments);
  const escSemanticGroups = semanticGroups.filter((g) => g.repo === "fusupo/escapement");
  const semGroup11 = escSemanticGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#11")
  );
  const semGroup13 = escSemanticGroups.find((g) =>
    g.nodes.some((n) => n.id === "esc#13")
  );
  const semSameGroup = semGroup11 === semGroup13;
  assert(!semSameGroup, "esc#11 and esc#13 in SEPARATE groups (semantic overlap)");

  // ─── 8. overlapKey canonical ordering ─────────────────────────────
  console.log("\n8. overlapKey");
  const key1 = overlapKey("esc#11", "esc#13", "shared/utils.ts");
  const key2 = overlapKey("esc#13", "esc#11", "shared/utils.ts");
  assert(key1 === key2, "overlapKey is order-independent");

  // ─── 9. computeOwnedFiles ─────────────────────────────────────────
  console.log("\n9. computeOwnedFiles");
  const overlapMap = buildOverlapMap(overlaps);
  const owned11 = computeOwnedFiles(
    ["manifest/queries/frontier.sql", "shared/utils.ts"],
    overlapMap.get("esc#11")
  );
  assert(
    owned11.includes("manifest/queries/frontier.sql"),
    "frontier.sql is owned by esc#11"
  );
  assert(
    !owned11.includes("shared/utils.ts"),
    "shared/utils.ts is NOT owned (shared)"
  );

  // ─── 10. computeForbiddenFiles ─────────────────────────────────────
  console.log("\n10. computeForbiddenFiles");
  const escFrontier = frontier.filter((f) => f.repo === "fusupo/escapement");
  const forbidden11 = computeForbiddenFiles("esc#11", escFrontier, overlapMap);
  assert(
    forbidden11.includes("src/components/Dashboard.tsx"),
    "Dashboard.tsx is forbidden for esc#11"
  );
  assert(
    !forbidden11.includes("shared/utils.ts"),
    "shared/utils.ts NOT forbidden (it's shared, not owned by other)"
  );

  // ─── 11. determineMergeOrder ───────────────────────────────────────
  console.log("\n11. determineMergeOrder");

  // No additive files -> undefined
  const noAdditiveGroup = groups[0];
  const noOrder = determineMergeOrder(noAdditiveGroup);
  // Check based on whether the group has additive shared files
  const hasAdditive = noAdditiveGroup.nodes.some((n) =>
    n.files_shared.some((sf) => sf.assessment === "additive")
  );
  if (!hasAdditive) {
    assert(noOrder === undefined, "No merge order when no additive files");
  }

  // Create a mock group with additive files
  const mockAdditiveGroup = {
    repo: "test",
    nodes: [
      {
        id: "a",
        name: "A",
        branch: "a-branch",
        files_owned: ["file1.ts"],
        files_shared: [
          { path: "shared.ts", assessment: "additive" as Assessment, confidence: "certain" as const, notes: "" },
          { path: "shared2.ts", assessment: "additive" as Assessment, confidence: "certain" as const, notes: "" },
        ],
        files_forbidden: [],
      },
      {
        id: "b",
        name: "B",
        branch: "b-branch",
        files_owned: ["file2.ts"],
        files_shared: [
          { path: "shared.ts", assessment: "additive" as Assessment, confidence: "certain" as const, notes: "" },
        ],
        files_forbidden: [],
      },
    ],
  };
  const additiveOrder = determineMergeOrder(mockAdditiveGroup);
  assert(additiveOrder !== undefined, "Merge order exists for additive group");
  assert(
    additiveOrder![0] === "b",
    "Item with fewer additive files merges first"
  );

  // ─── 12. buildValidationPolicy ─────────────────────────────────────
  console.log("\n12. buildValidationPolicy");
  const policy = buildValidationPolicy(groups);
  assert(
    policy.max_concurrent_node_heavy_tasks >= 1,
    `max_concurrent >= 1 (got ${policy.max_concurrent_node_heavy_tasks})`
  );
  assert(
    policy.serialized_checks.includes("typescript-build"),
    "typescript-build is serialized"
  );

  // ─── 13. buildDispatchPlan (full assembly) ─────────────────────────
  console.log("\n13. buildDispatchPlan");
  const plan = buildDispatchPlan(db);

  assert(plan.generated_at.length > 0, "generated_at is set");
  assert(plan.summary.dispatchable_now === 4, `4 dispatchable (got ${plan.summary.dispatchable_now})`);
  assert(plan.summary.blocked_count === 1, `1 blocked (got ${plan.summary.blocked_count})`);
  assert(plan.summary.human_gate_count === 1, `1 human-gated (got ${plan.summary.human_gate_count})`);
  assert(plan.sequential.length === 1, `1 sequential node (got ${plan.sequential.length})`);
  assert(plan.sequential[0].id === "esc#12", "esc#12 is sequential");
  assert(
    plan.sequential[0].blocked_by.includes("esc#13"),
    "esc#12 blocked by esc#13"
  );
  assert(plan.parallel_groups.length > 0, "Has parallel groups");
  assert(plan.assumptions.length > 0, "Has assumptions");

  // ─── 14. formatPlan ────────────────────────────────────────────────
  console.log("\n14. formatPlan");
  const output = formatPlan(plan);
  assert(output.includes("Dispatch Plan"), "Output contains title");
  assert(output.includes("Parallel Group"), "Output contains parallel groups");
  assert(output.includes("Sequential"), "Output contains sequential section");
  assert(output.includes("Validation Policy"), "Output contains validation policy");
  assert(output.includes("esc#12"), "Output mentions blocked item");

  // ─── 15. Multi-repo partitioning ───────────────────────────────────
  console.log("\n15. Multi-repo partitioning");
  const repoSet = new Set(plan.parallel_groups.map((g) => g.repo));
  assert(repoSet.has("fusupo/escapement"), "Has escapement groups");
  assert(repoSet.has("fusupo/other-repo"), "Has other-repo group");

  const otherPlanGroup = plan.parallel_groups.find(
    (g) => g.repo === "fusupo/other-repo"
  );
  assert(otherPlanGroup !== undefined, "other-repo has its own group");
  assert(
    otherPlanGroup!.nodes.length === 1,
    "other-repo group has 1 node"
  );

  // ─── Done ──────────────────────────────────────────────────────────
  console.log("\n\u2705 All plan tests passed!\n");
  db.close();
}

try {
  run();
} catch (e: any) {
  console.error("\n\u274c Test failed:", e.message);
  process.exit(1);
}
