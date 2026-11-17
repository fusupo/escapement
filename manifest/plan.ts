/**
 * plan.ts -- Dispatch planning for the manifest system.
 *
 * Queries the frontier, detects file overlaps, groups items into
 * parallel dispatch groups partitioned by repo, and assembles
 * a DispatchPlan structure.
 *
 * Conflict classification (trivial/additive/semantic/unknown) is
 * intended to be LLM-driven at skill invocation time. This module
 * provides the data scaffolding and grouping logic; the skill
 * layer fills in classification assessments.
 *
 * See: docs/MANIFEST_SYSTEM_DESIGN_V2.md Section 11
 */

import type { Database } from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Interfaces (from V2 Design Section 11.2)
// ---------------------------------------------------------------------------

export type Assessment = "trivial" | "additive" | "semantic" | "unknown";
export type Confidence = "certain" | "inferred" | "ambiguous";

export interface SharedFile {
  path: string;
  assessment: Assessment;
  confidence: Confidence;
  notes: string;
}

export interface PlanNode {
  id: string;
  name: string;
  branch: string;
  files_owned: string[];
  files_shared: SharedFile[];
  files_forbidden: string[];
  issue_url?: string;
}

export interface ParallelGroup {
  repo: string;
  nodes: PlanNode[];
  merge_order?: string[];
}

export interface SequentialNode {
  id: string;
  name: string;
  blocked_by: string[];
  reason: string;
}

export interface ValidationPolicy {
  max_concurrent_node_heavy_tasks: number;
  serialized_checks: string[];
}

export interface DispatchPlan {
  generated_at: string;
  assumptions: string[];
  parallel_groups: ParallelGroup[];
  sequential: SequentialNode[];
  validation_policy: ValidationPolicy;
  summary: {
    frontier_count: number;
    dispatchable_now: number;
    blocked_count: number;
    human_gate_count: number;
  };
}

// ---------------------------------------------------------------------------
// Frontier item (raw query result)
// ---------------------------------------------------------------------------

export interface FrontierItem {
  id: string;
  name: string;
  kind: string;
  repo: string | null;
  scope_hint: string | null;
  branch: string | null;
  issue_url: string | null;
  predicted_files: string[];
}

// ---------------------------------------------------------------------------
// Overlap pair (raw query result)
// ---------------------------------------------------------------------------

export interface OverlapPair {
  node_a: string;
  node_b: string;
  shared_files: string[];
}

// ---------------------------------------------------------------------------
// Blocked item (items with unmet dependencies)
// ---------------------------------------------------------------------------

export interface BlockedItem {
  id: string;
  name: string;
  blockers: { id: string; name: string; state: string }[];
}

// ---------------------------------------------------------------------------
// Human-gated item
// ---------------------------------------------------------------------------

export interface HumanGatedItem {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadQuery(name: string): string {
  return readFileSync(resolve(__dirname, "queries", `${name}.sql`), "utf-8");
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v === "string") return JSON.parse(v);
  if (Array.isArray(v)) return v;
  return [];
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Query the frontier: planned items with no unmet dependencies
 * and no human gate.
 */
export function queryFrontier(db: Database): FrontierItem[] {
  const sql = `
    SELECT w.id, w.name, w.kind, w.repo, w.scope_hint, w.branch,
           w.issue_url, w.predicted_files
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
  `;
  const rows = db.prepare(sql).all() as (Omit<FrontierItem, "predicted_files"> & { predicted_files: string })[];
  return rows.map((r) => ({
    ...r,
    predicted_files: parseJsonArray(r.predicted_files),
  }));
}

/**
 * Detect file overlaps across frontier items.
 * Returns pairs of items that share predicted files.
 */
export function queryOverlaps(db: Database): OverlapPair[] {
  const sql = loadQuery("overlap");
  const rows = db.prepare(sql).all() as { node_a: string; node_b: string; shared_files: string }[];
  return rows.map((r) => ({
    node_a: r.node_a,
    node_b: r.node_b,
    shared_files: parseJsonArray(r.shared_files),
  }));
}

/**
 * Query blocked items: planned items with unmet dependencies.
 */
export function queryBlocked(db: Database): BlockedItem[] {
  const sql = `
    SELECT w.id, w.name
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) = 0
      AND EXISTS (
        SELECT 1
        FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = w.id
          AND dep.state != 'done'
      )
    ORDER BY w.id
  `;
  const items = db.prepare(sql).all() as { id: string; name: string }[];

  const blocked: BlockedItem[] = [];
  for (const item of items) {
    const blockers = db.prepare(
      `SELECT blocker.id, blocker.name, blocker.state
       FROM edges e
       JOIN work_items blocker ON blocker.id = e.to_id
       WHERE e.rel = 'depends_on'
         AND e.from_id = ?
         AND blocker.state != 'done'
       ORDER BY blocker.id`
    ).all(item.id) as { id: string; name: string; state: string }[];

    blocked.push({
      id: item.id,
      name: item.name,
      blockers,
    });
  }

  return blocked;
}

/**
 * Query human-gated items.
 */
export function queryHumanGated(db: Database): HumanGatedItem[] {
  const sql = `
    SELECT w.id, w.name
    FROM work_items w
    WHERE w.kind IN ('issue', 'capability')
      AND w.state = 'planned'
      AND COALESCE(json_extract(w.meta, '$.needs_human'), 0) != 0
    ORDER BY w.id
  `;
  return db.prepare(sql).all() as HumanGatedItem[];
}

// ---------------------------------------------------------------------------
// Conflict classification (default: unknown)
// ---------------------------------------------------------------------------

/**
 * Build a default SharedFile entry for a shared path.
 * The assessment defaults to 'unknown' -- the skill layer (LLM)
 * is expected to upgrade this after reading the actual file.
 */
export function defaultSharedFile(path: string): SharedFile {
  return {
    path,
    assessment: "unknown",
    confidence: "ambiguous",
    notes: "Not yet classified -- requires LLM review",
  };
}

// ---------------------------------------------------------------------------
// Grouping logic
// ---------------------------------------------------------------------------

/**
 * Build an overlap map: for each node ID, which other node IDs
 * share files with it and what those files are.
 */
export function buildOverlapMap(
  overlaps: OverlapPair[]
): Map<string, Map<string, string[]>> {
  const map = new Map<string, Map<string, string[]>>();

  for (const pair of overlaps) {
    if (!map.has(pair.node_a)) map.set(pair.node_a, new Map());
    if (!map.has(pair.node_b)) map.set(pair.node_b, new Map());
    map.get(pair.node_a)!.set(pair.node_b, pair.shared_files);
    map.get(pair.node_b)!.set(pair.node_a, pair.shared_files);
  }

  return map;
}

/**
 * Compute files_owned for a node: predicted_files minus any
 * files shared with other frontier nodes.
 */
export function computeOwnedFiles(
  predictedFiles: string[],
  sharedFilesMap: Map<string, string[]> | undefined
): string[] {
  if (!sharedFilesMap) return [...predictedFiles];

  const allShared = new Set<string>();
  for (const files of sharedFilesMap.values()) {
    for (const f of files) allShared.add(f);
  }

  return predictedFiles.filter((f) => !allShared.has(f));
}

/**
 * Compute files_forbidden for a node: files predicted by other
 * frontier nodes in the same repo that are NOT shared with this node.
 * These are files the node should never touch.
 */
export function computeForbiddenFiles(
  nodeId: string,
  repoNodes: FrontierItem[],
  overlapMap: Map<string, Map<string, string[]>>
): string[] {
  const forbidden = new Set<string>();
  const nodeOverlaps = overlapMap.get(nodeId);

  for (const other of repoNodes) {
    if (other.id === nodeId) continue;
    const sharedWithOther = nodeOverlaps?.get(other.id) ?? [];
    const sharedSet = new Set(sharedWithOther);

    for (const f of other.predicted_files) {
      if (!sharedSet.has(f)) {
        forbidden.add(f);
      }
    }
  }

  return Array.from(forbidden).sort();
}

/**
 * Group frontier items into parallel groups partitioned by repo.
 *
 * Within a repo, items with semantic or unknown overlaps are placed
 * in separate groups. Items with only trivial or additive overlaps
 * (or no overlaps) can be in the same group.
 *
 * The assessments parameter allows the caller (skill/LLM) to provide
 * conflict classifications. If not provided, all shared files default
 * to 'unknown' (conservative).
 */
export function buildParallelGroups(
  frontier: FrontierItem[],
  overlaps: OverlapPair[],
  assessments?: Map<string, Assessment>
): ParallelGroup[] {
  const overlapMap = buildOverlapMap(overlaps);

  // Group by repo
  const byRepo = new Map<string, FrontierItem[]>();
  for (const item of frontier) {
    const repo = item.repo ?? "unknown";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(item);
  }

  const groups: ParallelGroup[] = [];

  for (const [repo, repoItems] of byRepo) {
    // Build a conflict graph: edges between items that have
    // semantic or unknown shared files
    const conflictEdges = new Set<string>();

    for (const pair of overlaps) {
      const itemA = repoItems.find((i) => i.id === pair.node_a);
      const itemB = repoItems.find((i) => i.id === pair.node_b);
      if (!itemA || !itemB) continue;

      // Check if any shared file is semantic or unknown
      const hasBlockingOverlap = pair.shared_files.some((f) => {
        const key = overlapKey(pair.node_a, pair.node_b, f);
        const assessment = assessments?.get(key) ?? "unknown";
        return assessment === "semantic" || assessment === "unknown";
      });

      if (hasBlockingOverlap) {
        conflictEdges.add(`${pair.node_a}|${pair.node_b}`);
      }
    }

    // Graph coloring: greedily assign items to groups such that
    // no two conflicting items share a group
    const itemGroups = new Map<string, number>();
    const groupCount = [0];

    for (const item of repoItems) {
      // Find groups this item conflicts with
      const forbiddenGroups = new Set<number>();
      for (const other of repoItems) {
        if (other.id === item.id) continue;
        const edge =
          conflictEdges.has(`${item.id}|${other.id}`) ||
          conflictEdges.has(`${other.id}|${item.id}`);
        if (edge && itemGroups.has(other.id)) {
          forbiddenGroups.add(itemGroups.get(other.id)!);
        }
      }

      // Find the lowest available group
      let assigned = -1;
      for (let g = 0; g < groupCount[0]; g++) {
        if (!forbiddenGroups.has(g)) {
          assigned = g;
          break;
        }
      }
      if (assigned === -1) {
        assigned = groupCount[0]++;
      }
      itemGroups.set(item.id, assigned);
    }

    // Build ParallelGroup for each color
    const colorGroups = new Map<number, PlanNode[]>();
    for (const item of repoItems) {
      const color = itemGroups.get(item.id)!;
      if (!colorGroups.has(color)) colorGroups.set(color, []);

      const nodeOverlaps = overlapMap.get(item.id);
      const ownedFiles = computeOwnedFiles(item.predicted_files, nodeOverlaps);
      const forbiddenFiles = computeForbiddenFiles(
        item.id,
        repoItems,
        overlapMap
      );

      // Build shared files list
      const sharedFiles: SharedFile[] = [];
      if (nodeOverlaps) {
        for (const [otherId, files] of nodeOverlaps) {
          // Only include overlaps with items in the same color group
          const otherColor = itemGroups.get(otherId);
          if (otherColor !== color) continue;

          for (const f of files) {
            const key = overlapKey(item.id, otherId, f);
            const assessment = assessments?.get(key) ?? "unknown";
            sharedFiles.push({
              path: f,
              assessment,
              confidence: assessments?.has(key) ? "certain" : "ambiguous",
              notes: assessments?.has(key)
                ? ""
                : "Not yet classified -- requires LLM review",
            });
          }
        }
      }

      // Deduplicate shared files by path
      const seenPaths = new Set<string>();
      const dedupedShared = sharedFiles.filter((sf) => {
        if (seenPaths.has(sf.path)) return false;
        seenPaths.add(sf.path);
        return true;
      });

      colorGroups.get(color)!.push({
        id: item.id,
        name: item.name,
        branch: item.branch ?? `${item.id.replace("#", "-")}-branch`,
        files_owned: ownedFiles,
        files_shared: dedupedShared,
        files_forbidden: forbiddenFiles,
        issue_url: item.issue_url ?? undefined,
      });
    }

    for (const [, nodes] of colorGroups) {
      groups.push({ repo, nodes });
    }
  }

  return groups;
}

/**
 * Create a canonical key for a shared file assessment.
 * Ensures consistent ordering of the node pair.
 */
export function overlapKey(
  nodeA: string,
  nodeB: string,
  filePath: string
): string {
  const [first, second] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];
  return `${first}|${second}|${filePath}`;
}

// ---------------------------------------------------------------------------
// Merge order determination
// ---------------------------------------------------------------------------

/**
 * Determine merge order for items in a parallel group that share
 * additive files. Items with fewer shared files merge first (they
 * are less likely to cause conflicts for later merges).
 */
export function determineMergeOrder(group: ParallelGroup): string[] | undefined {
  // Check if any nodes have additive shared files
  const hasAdditive = group.nodes.some((n) =>
    n.files_shared.some((sf) => sf.assessment === "additive")
  );

  if (!hasAdditive) return undefined;

  // Sort: nodes with fewer shared additive files go first
  const sorted = [...group.nodes].sort((a, b) => {
    const aCount = a.files_shared.filter(
      (sf) => sf.assessment === "additive"
    ).length;
    const bCount = b.files_shared.filter(
      (sf) => sf.assessment === "additive"
    ).length;
    return aCount - bCount;
  });

  return sorted.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Validation policy
// ---------------------------------------------------------------------------

/**
 * Emit a default validation policy based on the dispatch plan contents.
 */
export function buildValidationPolicy(
  groups: ParallelGroup[]
): ValidationPolicy {
  // Count total dispatchable nodes
  const totalNodes = groups.reduce((sum, g) => sum + g.nodes.length, 0);

  // Conservative defaults
  return {
    max_concurrent_node_heavy_tasks: Math.min(totalNodes, 2),
    serialized_checks: ["typescript-build", "integration-tests"],
  };
}

// ---------------------------------------------------------------------------
// Plan assembly
// ---------------------------------------------------------------------------

/**
 * Build sequential node list from blocked items.
 */
export function buildSequentialNodes(
  blocked: BlockedItem[]
): SequentialNode[] {
  return blocked.map((item) => ({
    id: item.id,
    name: item.name,
    blocked_by: item.blockers.map((b) => b.id),
    reason: `Waiting on: ${item.blockers
      .map((b) => `${b.id} (${b.state})`)
      .join(", ")}`,
  }));
}

/**
 * Assemble the full DispatchPlan from all components.
 */
export function buildDispatchPlan(
  db: Database,
  assessments?: Map<string, Assessment>
): DispatchPlan {
  const frontier = queryFrontier(db);
  const overlaps = queryOverlaps(db);
  const blocked = queryBlocked(db);
  const humanGated = queryHumanGated(db);

  const groups = buildParallelGroups(frontier, overlaps, assessments);

  // Apply merge order to each group
  for (const group of groups) {
    const order = determineMergeOrder(group);
    if (order) group.merge_order = order;
  }

  const validationPolicy = buildValidationPolicy(groups);
  const sequential = buildSequentialNodes(blocked);

  const assumptions: string[] = [];
  if (!assessments || assessments.size === 0) {
    assumptions.push(
      "No conflict classifications provided -- all shared files treated as 'unknown' (conservative)"
    );
  }
  if (frontier.some((f) => f.predicted_files.length === 0)) {
    assumptions.push(
      "Some frontier items have no predicted files -- they are assumed to have no file conflicts"
    );
  }

  return {
    generated_at: new Date().toISOString(),
    assumptions,
    parallel_groups: groups,
    sequential,
    validation_policy: validationPolicy,
    summary: {
      frontier_count: frontier.length + blocked.length + humanGated.length,
      dispatchable_now: frontier.length,
      blocked_count: blocked.length,
      human_gate_count: humanGated.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown formatter
// ---------------------------------------------------------------------------

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

/**
 * Format a DispatchPlan as human-readable markdown for chat output.
 */
export function formatPlan(plan: DispatchPlan): string {
  const lines: string[] = [];

  // Summary
  lines.push("# Dispatch Plan\n");
  lines.push(`Generated: ${plan.generated_at}\n`);
  lines.push("## Summary\n");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Frontier items | ${plan.summary.frontier_count} |`);
  lines.push(`| Dispatchable now | ${plan.summary.dispatchable_now} |`);
  lines.push(`| Blocked | ${plan.summary.blocked_count} |`);
  lines.push(`| Human-gated | ${plan.summary.human_gate_count} |`);
  lines.push("");

  // Assumptions
  if (plan.assumptions.length > 0) {
    lines.push("## Assumptions\n");
    for (const a of plan.assumptions) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  // Parallel Groups
  lines.push(`## Parallel Groups (${plan.parallel_groups.length})\n`);

  for (let i = 0; i < plan.parallel_groups.length; i++) {
    const group = plan.parallel_groups[i];
    lines.push(`### Group ${i + 1}: ${group.repo} (${group.nodes.length} items)\n`);

    for (const node of group.nodes) {
      lines.push(`**${node.id}**: ${node.name}`);
      if (node.issue_url) lines.push(`  Issue: ${node.issue_url}`);
      lines.push(`  Branch: ${node.branch}`);

      if (node.files_owned.length > 0) {
        lines.push(`  Files owned:`);
        for (const f of node.files_owned) {
          lines.push(`    - ${f}`);
        }
      }

      if (node.files_shared.length > 0) {
        lines.push(`  Shared files:`);
        for (const sf of node.files_shared) {
          lines.push(
            `    - ${sf.path} -- ${sf.assessment} (${sf.confidence})${sf.notes ? `: ${sf.notes}` : ""}`
          );
        }
      }

      if (node.files_forbidden.length > 0) {
        lines.push(`  Forbidden files:`);
        for (const f of node.files_forbidden) {
          lines.push(`    - ${f}`);
        }
      }

      lines.push("");
    }

    if (group.merge_order) {
      lines.push(
        `  Merge order: ${group.merge_order.join(" -> ")}\n`
      );
    }
  }

  // Sequential
  if (plan.sequential.length > 0) {
    lines.push("## Sequential (Blocked)\n");
    for (const node of plan.sequential) {
      lines.push(`**${node.id}**: ${node.name}`);
      lines.push(`  Blocked by: ${node.blocked_by.join(", ")}`);
      lines.push(`  Reason: ${node.reason}`);
      lines.push("");
    }
  }

  // Validation Policy
  lines.push("## Validation Policy\n");
  lines.push(
    `- Max concurrent Node-heavy tasks: ${plan.validation_policy.max_concurrent_node_heavy_tasks}`
  );
  lines.push(
    `- Serialized checks: ${plan.validation_policy.serialized_checks.join(", ")}`
  );
  lines.push("");

  return lines.join("\n");
}
