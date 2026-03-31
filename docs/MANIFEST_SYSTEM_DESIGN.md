# Manifest System: Dependency-Aware Parallel Work Orchestration

> Design document for a graph-based project manifest that enables dependency-aware parallel agent dispatch with file-level conflict avoidance.
>
> Captured: 2026-03-30 through 2026-03-31
> Status: Design phase — no implementation yet
> Context: Emerged from analysis of parallel development patterns across systema-relica (50+ issues), lightcone (50+ issues), and systema-relica-sdk (50+ issues)

---

## 1. Problem Statement

### The Single-Stream Bottleneck

Escapement's current workflow is sequential: one issue → one scratchpad → one branch → one agent session. This is correct for individual tasks but leaves significant parallelism on the table.

Analysis of the systema-relica issue history reveals that during any given development period, 4-9 issues are logically independent and could execute simultaneously. For example, form hardening issues #586-#589 are four independent issues following the same pattern — each touches different files in different domain directories. Running them sequentially when they could run in parallel is a velocity ceiling.

### The Missing Artifact

Project state currently lives in three disconnected formats:

| Format | What it captures | What it lacks |
|--------|-----------------|---------------|
| Design docs (PRODUCT_ARC, META_MODEL_EXPANSION, METHOD_RUNTIME_CONTEXT) | Vision, architecture, rationale, phasing | Not executable. No dependency edges. No state. |
| GitHub issues | Individual work units, some with state | No hierarchy. No "this unlocks that." Flat. |
| Developer's mental model | The actual dependency graph, what's parallel, what's blocked | Not persistent. Not shareable with agents. |

### What's Needed

A structured, queryable artifact that represents:
- The dependency topology of all planned and in-progress work
- File-level scope predictions for conflict avoidance
- Which work is dispatchable right now
- Which dispatchable items can safely run in parallel
- Provenance links to archives of completed work

---

## 2. Architecture Overview

### System Components

```
MANIFEST (PGlite)                    ORCHESTRATOR                         AGENTS
┌─────────────────┐                 ┌──────────────────┐                ┌─────────────┐
│ frontier query   │──── dispatch ──→│ create worktrees  │──── spawn ───→│ claude (A)  │
│ conflict check   │     plan       │ assign branches   │               │ claude (B)  │
│ parallel groups  │                │ write scratchpads │               │ claude (C)  │
└─────────────────┘                │ launch sessions   │               └──────┬──────┘
       ▲                           └────────┬─────────┘                       │
       │                                    │                                 │
       │              ┌─────────────────────┘                                 │
       │              ▼                                                       │
       │     MONITOR / FEEDBACK                                               │
       │     ┌──────────────────┐                                             │
       └─────│ watch for done   │◄──── PR merged / branch done ──────────────┘
             │ update manifest  │
             │ recompute frontier│
             │ dispatch next    │
             └──────────────────┘
```

### Technology Choices

**PGlite** (PostgreSQL in WASM) for the manifest database:
- Full PostgreSQL SQL dialect — same as the rest of the Relica stack (Archivist, Aperture, Shutter all use Postgres)
- `JSONB` for structured metadata with indexable queries
- `TEXT[]` arrays with GIN indexes for file set overlap detection (`&&` operator)
- Runs in-process in Node.js — no server, no Docker, no infrastructure
- ~3MB, single data directory, lives in the context-path
- Queries written for PGlite port verbatim to production PostgreSQL if the manifest ever graduates into Relica proper
- pgvector extension available if semantic similarity between work items becomes useful later

**Location:**
```
{context-path}/
  manifest/
    pgdata/          ← PGlite data directory
    queries/         ← .sql files for standard operations
    seed.ts          ← initial population script
    manifest-cli.ts  ← thin CLI wrapper for Escapement skills
```

Where `{context-path}` is the project's existing Escapement context directory (e.g., `~/Relica/dev/systema-relica-ctx/`).

---

## 3. Data Model

### Design Principle: Triples Represent Structure, Not Logs

The triple table represents the **dependency/conflict/composition graph** — timeless structural assertions about relationships between entities. Temporal information (when things happened, confidence levels, audit trails) lives as metadata on entities and triples, not as triples themselves.

**Test for "should this be a triple?"**: Does the frontier/dispatch planner need to traverse it as an edge? If yes, it's a triple. If no, it's metadata on an entity or triple.

### Schema

```sql
CREATE TABLE entities (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL
                CHECK (type IN (
                  'issue',        -- GitHub issue (concrete work item)
                  'capability',   -- Abstract capability not yet linked to an issue
                  'file',         -- Source file in a repository
                  'phase',        -- High-level project phase
                  'track',        -- Parallel work track within a phase
                  'archive'       -- Archive location for completed work
                )),
    status      TEXT DEFAULT 'unmanifest'
                CHECK (status IN ('unmanifest', 'manifesting', 'manifest')),
    repo        TEXT,             -- 'systema-relica', 'lightcone', 'systema-relica-sdk'
    scope       TEXT,             -- package/directory scope, or file path for type='file'
    files       TEXT[],           -- predicted file paths this entity will touch
    issue_url   TEXT,             -- GitHub issue URL if linked
    branch      TEXT,             -- branch name while manifesting
    archive_path TEXT,            -- context-path location of completed work artifacts
    meta        JSONB DEFAULT '{}',
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE triples (
    id          SERIAL PRIMARY KEY,
    lh          TEXT NOT NULL REFERENCES entities(id),
    rel         TEXT NOT NULL
                CHECK (rel IN (
                  'depends_on',          -- lh cannot start until rh is manifest
                  'unlocks',             -- completing lh makes rh dispatchable
                  'is_part_of',          -- lh is a component of rh (phase/track hierarchy)
                  'touches_file',        -- lh will modify rh (file entity)
                  'conflicts_with',      -- lh and rh touch same files with overlap
                  'parallel_safe_with',  -- lh and rh confirmed safe to run simultaneously
                  'implemented_by',      -- lh (capability) realized by rh (issue)
                  'archived_at'          -- lh (completed node) → rh (archive location)
                )),
    rh          TEXT NOT NULL REFERENCES entities(id),
    confidence  TEXT DEFAULT 'certain'
                CHECK (confidence IN ('certain', 'inferred', 'ambiguous')),
    status      TEXT,             -- conflict type: 'semantic', 'additive', 'trivial'
    meta        JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes for the queries the planner actually runs
CREATE INDEX idx_triples_rel ON triples(rel);
CREATE INDEX idx_triples_lh ON triples(lh);
CREATE INDEX idx_triples_rh ON triples(rh);
CREATE INDEX idx_entities_status ON entities(status);
CREATE INDEX idx_entities_files ON entities USING gin(files);
CREATE INDEX idx_triples_confidence ON triples(confidence);
```

### Entity ID Conventions

Entities use stable IDs that survive renames and restructuring:

| Type | ID pattern | Example |
|------|-----------|---------|
| Issue | `{repo_short}#{number}` | `sr#586`, `lc#208`, `sdk#139` |
| Capability | `{descriptive_slug}` | `deprecate_construct`, `setState_method` |
| File | `file:{stable_name}` | `file:useClarity2Modelling`, `file:portal_gateway` |
| Phase | `phase:{name}` | `phase:quintessential_infrastructure` |
| Track | `track:{phase}:{name}` | `track:phase1:dsl_constructs` |
| Archive | `archive:{branch_slug}` | `archive:640-deprecate-construct` |

**File entity stability**: The `id` is a stable handle. The `scope` column holds the current filesystem path. If a file moves, update `scope` — all triples remain valid. This decouples the graph structure from the filesystem layout.

### Relation Types

| rel | Structural meaning | Used by planner? |
|-----|-------------------|-----------------|
| `depends_on` | lh cannot start until rh is manifest | Yes — frontier query |
| `unlocks` | Completing lh makes rh dispatchable | Yes — "what does finishing X enable?" |
| `is_part_of` | lh is a component of rh (hierarchy) | Yes — progress rollup |
| `touches_file` | lh will modify rh (file entity) | Yes — conflict detection |
| `conflicts_with` | lh and rh touch overlapping files | Yes — parallel grouping |
| `parallel_safe_with` | lh and rh confirmed safe to parallelize | Yes — dispatch plan |
| `implemented_by` | Abstract capability → concrete issue | Yes — linking planned to actual |
| `archived_at` | Completed node → archive entity | Yes — provenance queries |

### Metadata Conventions

**Entity `meta` JSONB** stores lifecycle and audit information:

```jsonc
{
  // Disambiguation tracking
  "disambiguation": {
    "date": "2026-03-31",
    "github_comment_id": 12345,
    "type": "scope_clarification"
  },
  // Post-completion reconciliation
  "predicted_files": ["writer.ts", "form.tsx"],
  "actual_files": ["writer.ts", "form.tsx", "constants.ts"],
  "file_drift": ["constants.ts"]
}
```

**Triple `meta` JSONB** stores provenance of the assertion:

```jsonc
{
  "source": "issue body mentions #585",
  "discovered_at": "bootstrap",     // or "check", "manual"
  "conflict_file": "portal.gateway.ts"  // for conflicts_with triples
}
```

**Triple `confidence`** column:
- `certain` — explicitly stated in issue, confirmed by user, or verified by git
- `inferred` — agent derived from codebase analysis or pattern matching
- `ambiguous` — agent uncertain, needs user disambiguation

---

## 4. Core Operations

### 4.1 Frontier Query (What's Dispatchable?)

```sql
-- All unmanifest entities whose dependencies are all manifest
SELECT e.id, e.name, e.repo, e.scope, e.files
FROM entities e
WHERE e.status = 'unmanifest'
  AND e.type IN ('issue', 'capability')
  AND NOT EXISTS (
    SELECT 1 FROM triples t
    JOIN entities dep ON t.lh = e.id AND t.rh = dep.id
    WHERE t.rel = 'depends_on'
      AND dep.status != 'manifest'
  );
```

### 4.2 Parallel Grouping (What Can Run Together?)

```sql
-- From the frontier set, find pairs with semantic conflicts
-- (these CANNOT run in parallel)
WITH frontier AS (
  SELECT e.id, e.name, e.files
  FROM entities e
  WHERE e.status = 'unmanifest'
    AND e.type IN ('issue', 'capability')
    AND NOT EXISTS (
      SELECT 1 FROM triples t
      JOIN entities dep ON t.lh = e.id AND t.rh = dep.id
      WHERE t.rel = 'depends_on'
        AND dep.status != 'manifest'
    )
)
SELECT a.id as node_a, b.id as node_b, t.status as conflict_type,
       t.meta->>'conflict_file' as conflict_file
FROM triples t
JOIN frontier a ON t.lh = a.id
JOIN frontier b ON t.rh = b.id
WHERE t.rel = 'conflicts_with'
  AND t.status = 'semantic';
```

### 4.3 File Overlap Detection (Discover Conflicts)

```sql
-- Find frontier nodes whose predicted file sets overlap
-- (potential conflicts not yet recorded as triples)
WITH frontier AS (
  SELECT id, name, files FROM entities
  WHERE status = 'unmanifest' AND files IS NOT NULL
    AND type IN ('issue', 'capability')
    AND NOT EXISTS (
      SELECT 1 FROM triples t
      JOIN entities dep ON t.lh = entities.id AND t.rh = dep.id
      WHERE t.rel = 'depends_on' AND dep.status != 'manifest'
    )
)
SELECT a.id as node_a, b.id as node_b,
       a.files & b.files as shared_files
FROM frontier a, frontier b
WHERE a.id < b.id
  AND a.files && b.files;
```

### 4.4 Completion Impact (What Does Finishing X Unlock?)

```sql
SELECT e.id, e.name, e.status
FROM triples t
JOIN entities e ON t.rh = e.id
WHERE t.lh = $completed_node
  AND t.rel = 'unlocks';
```

### 4.5 Phase Progress

```sql
SELECT
  p.name as phase,
  COUNT(*) as total,
  SUM(CASE WHEN e.status = 'manifest' THEN 1 ELSE 0 END) as done,
  ROUND(100.0 * SUM(CASE WHEN e.status = 'manifest' THEN 1 ELSE 0 END) / COUNT(*), 1) as pct
FROM triples t
JOIN entities e ON t.lh = e.id
JOIN entities p ON t.rh = p.id
WHERE t.rel = 'is_part_of'
GROUP BY p.name;
```

### 4.6 Provenance (What Work Produced This?)

```sql
SELECT a.scope as archive_path, e.name, e.issue_url, e.branch
FROM triples t
JOIN entities a ON t.rh = a.id
JOIN entities e ON t.lh = e.id
WHERE t.rel = 'archived_at'
  AND e.id = $node_id;
```

---

## 5. Workflow Integration

### 5.1 Graph Bootstrap (Cold Start)

**Trigger**: First time using the manifest on a repo with existing issues, or "build a manifest from these issues."

**Process**:

1. **Agent reads all open issues** across target repos (via GitHub MCP tools) plus any design documents that describe planned work.

2. **Agent analyzes codebase structure** — package boundaries, file organization, existing patterns — to predict file sets per issue.

3. **Agent produces entities and triples** with confidence levels:
   - `certain` — dependency explicitly stated in issue body ("depends on #585")
   - `inferred` — derived from codebase analysis ("same form pattern, will touch useClarity2Modelling.ts")
   - `ambiguous` — agent can't determine from available information

4. **Agent surfaces ambiguities as structured questions** to the user:
   ```
   I'm uncertain about 3 dependencies:

   1. Does #589 (Individual Occurrence form) need #598
      (Clarity2 REST routes) to be done first, or can it
      work over the existing WS path?

   2. #600 (aspect assignment) mentions the method runtime's
      addAspect — is this a hard dependency on the runtime
      being deployed, or just the same pattern?

   3. #632 (defensive deployment) — I can't determine any
      file-level scope from the issue body. What files/packages
      does this touch?
   ```

5. **User answers** → agent upgrades triples to `certain` or removes them.

6. **Disambiguation propagates back to GitHub issues**. For each resolved ambiguity, the agent:
   - Adds a structured comment to the GitHub issue with scope/dependency clarification
   - Optionally updates the issue body with a `## Scope` section listing predicted files, dependencies, and conflict notes
   - This makes issues self-contained — future readers (human or agent) don't need the manifest to understand scope

   Example issue comment:
   ```markdown
   ### Manifest Disambiguation (2026-03-31)

   **Dependency clarification:**
   - This issue depends on #598 (Clarity2 REST routes) — the occurrence
     form needs the REST path for preview/persist.

   **Scope clarification:**
   - Files: `IndividualOccurrenceForm.tsx`, `occurrence-individual.writer.ts`,
     `occurrence-individual.reader.ts`, `useClarity2Modelling.ts` (additive)

   **Conflict notes:**
   - `useClarity2Modelling.ts` shared with #586, #587, #588 — additive only
   ```

7. **Manifest is seeded** — PGlite database populated, ready for queries.

### 5.2 Graph Maintenance (Ad-hoc Recheck)

**Trigger**: Explicitly ("recheck the manifest"), after a merge conflict, after N completions, or when new issues are filed.

**Process**:

1. **Staleness check**: Entities marked `manifesting` with no branch activity.

2. **File set reconciliation** (post-completion): Compare predicted files vs actual files changed in the merged PR. Record drift in entity `meta`. If unpredicted files appear, they become data for future conflict detection.

3. **New issue integration**: Read newly filed issues, create entities, infer dependencies against existing graph, surface ambiguities.

4. **Conflict discovery**: Re-run file overlap detection across current frontier. Record any new `conflicts_with` triples discovered.

5. **Disambiguation propagation**: Any resolved ambiguities during recheck get written back to the corresponding GitHub issues as comments or body edits, same as during bootstrap.

6. **Graph consistency check**:
   ```sql
   -- Entities marked manifest whose children still show unmet deps
   -- (indicates a graph error)
   SELECT child.id, child.name, blocker.id as still_blocked_by
   FROM triples t_unlock
   JOIN entities child ON t_unlock.rh = child.id
   JOIN triples t_dep ON t_dep.rh = child.id AND t_dep.rel = 'depends_on'
   JOIN entities blocker ON t_dep.lh = blocker.id
   WHERE t_unlock.lh IN (SELECT id FROM entities WHERE status = 'manifest')
     AND t_unlock.rel = 'unlocks'
     AND blocker.status != 'manifest';
   ```

### 5.3 Dispatch Planning

**Trigger**: "What can I work on?" or "plan next sprint."

**Process**:

1. Run frontier query → list of dispatchable nodes
2. Run file overlap detection → identify conflict pairs
3. Classify conflicts: semantic (can't parallelize), additive (parallelize with merge order), trivial (auto-resolvable)
4. Group nodes into parallel dispatch groups
5. Output a dispatch plan:

```typescript
interface DispatchPlan {
  parallel_groups: {
    nodes: string[];           // entity IDs safe to run simultaneously
    merge_order?: string[];    // if additive conflicts, merge in this order
    conflict_files?: string[]; // files to watch for unexpected overlap
  }[];
  sequential: {
    node: string;
    blocked_by: string[];      // what must finish first
  }[];
}
```

### 5.4 Work Dispatch

**Trigger**: "Spin up parallel work" or "dispatch the plan."

**Process for each node in a parallel group**:

1. Create a git worktree: `git worktree add "../sr-work-${node_id}" develop-ts`
2. Create a feature branch in the worktree
3. Generate or invoke `setup-work` to create a scratchpad
4. Launch a Claude session with:
   - The issue context and scratchpad
   - **Positive file scope**: files this agent is expected to touch
   - **Negative file constraint**: files owned by other parallel agents — must not touch
5. Update manifest: `status = 'manifesting'`, record branch name
6. Record PID or session identifier for monitoring

**Agent constraint enforcement**: Each dispatched agent receives explicit instructions about file ownership boundaries. The orchestrator derives these from the manifest's `touches_file` triples and `conflicts_with` analysis:

```
You are working on: #586 (Individual Aspect form hardening)

Files you own (may modify freely):
- packages/viewfinder/src/pages/Modelling/individuals/IndividualAspectForm.tsx
- packages/clarity2/src/domains/aspect/individual/aspect-individual.writer.ts
- packages/clarity2/src/domains/aspect/individual/aspect-individual.reader.ts

Shared files (modify your section only — other agents are adding cases too):
- packages/viewfinder/src/hooks/useClarity2Modelling.ts
  → Add/fix the "individual-aspect" case only

Files you must NOT touch (owned by parallel agents):
- packages/viewfinder/src/pages/Modelling/individuals/IndividualRoleForm.tsx
- packages/viewfinder/src/pages/Modelling/individuals/IndividualRelationForm.tsx
- packages/viewfinder/src/pages/Modelling/individuals/IndividualOccurrenceForm.tsx
- packages/clarity2/src/domains/role/
- packages/clarity2/src/domains/relation/
- packages/clarity2/src/domains/occurrence/
```

### 5.5 Completion & Sync

**Trigger**: PR merged, or agent signals completion, or "mark X done."

**Process**:

1. Update entity status: `manifest`
2. Record archive path (linking to Escapement's context-path archive):
   ```sql
   -- Create archive entity
   INSERT INTO entities (id, name, type, repo, scope) VALUES
     ('archive:640-deprecate', '640-deprecate-construct/archive/', 'archive',
      'systema-relica', 'systema-relica-ctx/640-deprecate-construct/archive/');

   -- Link completed node to archive
   INSERT INTO triples (lh, rel, rh, confidence) VALUES
     ('deprecate_construct', 'archived_at', 'archive:640-deprecate', 'certain');

   -- Update entity
   UPDATE entities SET
     status = 'manifest',
     archive_path = 'systema-relica-ctx/640-deprecate-construct/archive/',
     updated_at = now()
   WHERE id = 'deprecate_construct';
   ```

3. File set reconciliation: compare predicted vs actual files from the merged PR
4. Recompute frontier: new nodes may now be unblocked
5. If newly unblocked nodes exist, report them and optionally trigger a new dispatch cycle
6. Clean up worktree: `git worktree remove "../sr-work-${node_id}"`

---

## 6. Escapement Integration

### New Skills

| Skill | Trigger | What it does |
|---|---|---|
| `manifest-bootstrap` | "build a manifest from these issues" | Reads open issues + codebase, produces graph, surfaces ambiguities for Q&A, propagates disambiguation to GitHub issues |
| `manifest-check` | "recheck the manifest" / post-merge hook | Reconciles predictions vs actuals, surfaces drift, integrates new issues, propagates disambiguation to GitHub issues |
| `manifest-plan` | "what's dispatchable?" / "plan next sprint" | Queries frontier, runs conflict analysis, outputs dispatch plan |
| `manifest-dispatch` | "spin up parallel work" / "dispatch the plan" | Creates worktrees, branches, scratchpads, launches parallel agent sessions |
| `manifest-sync` | "mark X done" / PR merge hook | Updates status, records archive path, recomputes frontier, reports newly unblocked |

### Integration with Existing Skills

Existing Escapement skills are **unchanged**. The manifest layer sits above them:

| Existing skill | How manifest interacts |
|---|---|
| `setup-work` | Invoked by `manifest-dispatch` per-worktree, same as manual invocation |
| `do-work` | Runs in each parallel agent session — same as today |
| `commit-changes` | Unchanged — each agent commits in its own worktree |
| `create-pr` | Unchanged — each agent creates a PR from its branch |
| `archive-work` | Invoked after merge. `manifest-sync` reads the archive path and records it |
| `prime-session` | Could read manifest for additional context ("you're working on a node in Phase 1") |

### Archive Association

Escapement already writes completed work to a structured archive in the context-path:

```
systema-relica-ctx/
  INDEX.md                              ← existing Escapement index
  640-deprecate-construct/
    archive/
      SCRATCHPAD_640.md
      SESSION_LOG_1.md
      SESSION_LOG_2.md
  641-occurrence-form/
    archive/
      SCRATCHPAD_641.md
      SESSION_LOG_1.md
  manifest/
    pgdata/                             ← PGlite data directory
```

When `manifest-sync` marks a node as manifest, it:
1. Reads the archive path from the Escapement context-path structure
2. Creates an `archive` entity in the manifest
3. Inserts an `archived_at` triple linking the completed node to the archive entity
4. The archive entity's `scope` field holds the filesystem path

This enables provenance queries: "show me the session logs that produced the deprecate construct" → follow the `archived_at` triple → read the archive directory.

---

## 7. Conflict Classification

### Three Kinds of File Conflicts

Not all shared files create equal risk. The manifest classifies conflicts by type:

| Type | Description | Example | Can parallelize? |
|---|---|---|---|
| **Trivial** | Barrel exports, auto-generated indexes | `index.ts` adding a new export line | Yes — auto-resolvable |
| **Additive** | Multiple agents add independent sections to the same file | Switch cases in `useClarity2Modelling.ts` | Yes — with merge order |
| **Semantic** | Overlapping logic changes in the same functions | Both modifying `method-runtime.service.ts` dispatch logic | No — must sequence |

The `conflicts_with` triple's `status` column records the conflict type. The dispatch planner uses this to determine grouping:
- Nodes with only trivial/additive conflicts → same parallel group, with merge order specified
- Nodes with semantic conflicts → different groups or sequenced

### Conflict Learning

The manifest learns from experience. When a merge conflict occurs that wasn't predicted:

```sql
-- Record the actual conflict
INSERT INTO triples (lh, rel, rh, confidence, status, meta) VALUES
  ($node_a, 'conflicts_with', $node_b, 'certain', 'semantic',
   '{"file": "portal.gateway.ts", "discovered": "at_merge"}'::jsonb);
```

When post-completion file reconciliation reveals unpredicted files:

```sql
-- Update the entity's meta with drift information
UPDATE entities SET meta = jsonb_set(
  meta, '{file_drift}',
  to_jsonb(array(
    SELECT unnest($actual_files)
    EXCEPT
    SELECT unnest(files)
  ))
) WHERE id = $node_id;
```

Files that repeatedly appear as drift become known conflict zones — the bootstrap and check processes learn to flag them for future work in the same area.

---

## 8. Dispatch Plan Output Format

The dispatch plan is the artifact that bridges planning and execution. It's the output of `manifest-plan` and the input to `manifest-dispatch`:

```typescript
interface DispatchPlan {
  generated_at: string;                // ISO timestamp

  parallel_groups: ParallelGroup[];    // groups safe to run simultaneously
  sequential: SequentialNode[];        // nodes that must wait

  summary: {
    total_frontier: number;            // total dispatchable nodes
    parallel_capacity: number;         // how many can run right now
    blocked_count: number;             // nodes waiting on dependencies
    ambiguous_count: number;           // nodes with uncertain dependencies
  };
}

interface ParallelGroup {
  nodes: {
    id: string;                        // entity ID
    name: string;
    repo: string;
    scope: string;
    files_owned: string[];             // files this agent may modify
    files_shared: {                    // files shared with others in this group
      path: string;
      conflict_type: 'trivial' | 'additive';
      notes: string;                   // e.g., "add your switch case only"
    }[];
    files_forbidden: string[];         // files owned by other parallel agents
    issue_url?: string;
  }[];
  merge_order?: string[];              // if additive conflicts, merge in this order
}

interface SequentialNode {
  id: string;
  name: string;
  blocked_by: string[];                // entity IDs that must complete first
  estimated_unblock: string;           // which parallel group completion unblocks this
}
```

---

## 9. Post-MVP: Codebase Awareness via isomorphic-git

### Problem

The manifest's file model is point-in-time. Files move, get renamed, get deleted. The `scope` column on file entities becomes stale after refactors.

### Solution

[isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) provides programmatic access to the git object model from the same Node.js/TypeScript process that runs PGlite. No subprocess spawning, no stdout parsing — structured data.

### Capabilities It Enables

**1. File set prediction from prior PRs.** During bootstrap, when an issue says "same pattern as #585," the agent can inspect what files PR #597 (which implemented #585) actually touched — grounded in git history, not LLM guessing.

**2. Live conflict detection between in-flight branches.** While parallel agents work, diff their branches against each other without merging. Alert if branches start overlapping on files the manifest didn't predict.

**3. Automatic `actual_files` population.** After PR merge, walk the tree diff programmatically and write the file list directly to entity meta. No parsing of `git diff` output.

**4. Rename tracking.** When `manifest-check` finds a file entity whose `scope` path no longer exists, use git's rename detection to find where it went and update the entity.

### Why isomorphic-git Specifically

| Concern | git CLI via Bash | isomorphic-git |
|---|---|---|
| Rename tracking | `git log --follow` (fragile parsing) | Programmatic tree walk |
| Cross-branch diff | String output, needs parsing | Structured JS data |
| Process model | Subprocess per command | Same Node.js process as PGlite |
| Worktree support | Needs `--git-dir` flags | Point at any `.git` directory |

Performance is slower than native git but manifest operations are infrequent — bootstrap, check, post-merge sync. The structured data advantage outweighs the speed cost.

### Entity Changelog (Post-MVP)

When codebase tracking matters, a simple append-only log captures structural changes without polluting the triple table:

```sql
CREATE TABLE entity_changelog (
    entity_id   TEXT REFERENCES entities(id),
    field       TEXT,          -- 'scope', 'status', 'name'
    old_value   TEXT,
    new_value   TEXT,
    changed_at  TIMESTAMPTZ DEFAULT now(),
    reason      TEXT           -- 'file_rename', 'refactor', 'manifest_check'
);
```

The planner never queries this table. It exists for "what happened?" investigations, not "what should I do?" decisions.

---

## 10. Example: Seeding from Real Issues

To illustrate how the manifest captures a real project state, here's a partial seed based on the systema-relica issue analysis that motivated this design:

```sql
-- Phase
INSERT INTO entities (id, name, type, status) VALUES
  ('phase:quint_infra', 'Phase 1: Quintessential Infrastructure', 'phase', 'unmanifest');

-- Tracks within Phase 1
INSERT INTO entities (id, name, type, status) VALUES
  ('track:phase1:dsl', 'DSL Constructs', 'track', 'unmanifest'),
  ('track:phase1:methods', 'Method Definitions', 'track', 'unmanifest'),
  ('track:phase1:sdk_ops', 'SDK Operation Groups', 'track', 'unmanifest'),
  ('track:phase1:lightcone', 'Lightcone Universal Resolution', 'track', 'unmanifest');

-- Capabilities (not yet linked to issues)
INSERT INTO entities (id, name, type, status, repo, scope) VALUES
  ('deprecate_construct', 'deprecate DSL construct', 'capability', 'unmanifest',
   'systema-relica', 'packages/archivist/src/method-runtime/dsl/'),
  ('query_bind_construct', 'query-bind DSL construct', 'capability', 'unmanifest',
   'systema-relica', 'packages/archivist/src/method-runtime/dsl/'),
  ('guard_construct', 'guard DSL construct', 'capability', 'unmanifest',
   'systema-relica', 'packages/archivist/src/method-runtime/dsl/'),
  ('setState_method', 'setState method definition', 'capability', 'unmanifest',
   'systema-relica', 'packages/archivist/src/method-runtime/methods/');

-- Existing open issues
INSERT INTO entities (id, name, type, status, repo, issue_url, files) VALUES
  ('sr#586', 'Harden flat form: Individual Aspect', 'issue', 'unmanifest',
   'systema-relica', 'https://github.com/corpus-relica/systema-relica/issues/586',
   ARRAY[
     'packages/viewfinder/src/pages/Modelling/individuals/IndividualAspectForm.tsx',
     'packages/clarity2/src/domains/aspect/individual/aspect-individual.writer.ts',
     'packages/clarity2/src/domains/aspect/individual/aspect-individual.reader.ts',
     'packages/viewfinder/src/hooks/useClarity2Modelling.ts'
   ]),
  ('sr#587', 'Harden flat form: Individual Role', 'issue', 'unmanifest',
   'systema-relica', 'https://github.com/corpus-relica/systema-relica/issues/587',
   ARRAY[
     'packages/viewfinder/src/pages/Modelling/individuals/IndividualRoleForm.tsx',
     'packages/clarity2/src/domains/role/individual/role-individual.writer.ts',
     'packages/clarity2/src/domains/role/individual/role-individual.reader.ts',
     'packages/viewfinder/src/hooks/useClarity2Modelling.ts'
   ]);

-- Completed work (for context)
INSERT INTO entities (id, name, type, status, repo, issue_url, archive_path) VALUES
  ('sr#585', 'Harden flat form: Individual Physical Object', 'issue', 'manifest',
   'systema-relica', 'https://github.com/corpus-relica/systema-relica/issues/585',
   'systema-relica-ctx/585-individual-physobj/archive/');

-- File entities
INSERT INTO entities (id, name, type, scope, repo) VALUES
  ('file:useClarity2Modelling', 'useClarity2Modelling.ts', 'file',
   'packages/viewfinder/src/hooks/useClarity2Modelling.ts', 'systema-relica');

-- Structural triples
INSERT INTO triples (lh, rel, rh, confidence) VALUES
  -- Track composition
  ('track:phase1:dsl', 'is_part_of', 'phase:quint_infra', 'certain'),
  ('track:phase1:methods', 'is_part_of', 'phase:quint_infra', 'certain'),
  ('track:phase1:sdk_ops', 'is_part_of', 'phase:quint_infra', 'certain'),
  ('track:phase1:lightcone', 'is_part_of', 'phase:quint_infra', 'certain'),

  -- Capability → track
  ('deprecate_construct', 'is_part_of', 'track:phase1:dsl', 'certain'),
  ('query_bind_construct', 'is_part_of', 'track:phase1:dsl', 'certain'),
  ('guard_construct', 'is_part_of', 'track:phase1:dsl', 'certain'),
  ('setState_method', 'is_part_of', 'track:phase1:methods', 'certain'),

  -- Dependencies
  ('setState_method', 'depends_on', 'deprecate_construct', 'certain'),
  ('setState_method', 'depends_on', 'query_bind_construct', 'certain'),
  ('setState_method', 'depends_on', 'guard_construct', 'certain'),
  ('sr#586', 'depends_on', 'sr#585', 'certain'),
  ('sr#587', 'depends_on', 'sr#585', 'certain'),

  -- Unlocks (inverse of depends_on where useful)
  ('deprecate_construct', 'unlocks', 'setState_method', 'certain'),

  -- File touches
  ('sr#586', 'touches_file', 'file:useClarity2Modelling', 'inferred'),
  ('sr#587', 'touches_file', 'file:useClarity2Modelling', 'inferred'),

  -- Conflict (both touch same file, but additive only)
  ('sr#586', 'conflicts_with', 'sr#587', 'inferred');
-- Set conflict type
UPDATE triples SET status = 'additive'
WHERE lh = 'sr#586' AND rel = 'conflicts_with' AND rh = 'sr#587';
```

---

## 11. Open Questions

1. **Multi-repo coordination**: The manifest spans three repos. Worktree dispatch works per-repo. How does the orchestrator handle a dispatch plan that includes nodes from different repos? Likely: one worktree per repo per parallel group, with the dispatch plan grouping by repo.

2. **Agent session management**: What's the best mechanism for launching and monitoring parallel Claude sessions? Options: `claude --print` headless mode, Claude Code agent teams (experimental), or manual terminal management with tmux.

3. **Merge order enforcement**: When additive conflicts exist, the dispatch plan specifies a merge order. How is this enforced? Options: agents complete independently and merge sequentially, or later agents wait for earlier ones to merge before they push.

4. **Manifest versioning**: Should the PGlite database be git-tracked? It's a directory, not a single file, which makes git tracking awkward. Alternative: periodic SQL dump exports alongside the database.

5. **Scope of parallelism**: Given machine resource constraints (documented in systema-relica CLAUDE.md — never run tests in parallel, avoid multiple Node processes), what's the practical maximum number of parallel agents? Likely 2-3 on the current machine.

6. **Capability → issue lifecycle**: When does an abstract capability node get an issue created for it? At dispatch time? During sprint planning? Should `manifest-dispatch` auto-create GitHub issues for capability nodes that lack them?

---

## 12. Relationship to Other Documents

This design builds on context from:

- **systema-relica** `docs/METHOD_RUNTIME_CONTEXT.md` — Method runtime architecture and forward DSL constructs. The "Expected Construct Emergence by Operation" table is exactly the kind of dependency structure the manifest captures.

- **lightcone** `docs/dev/META_MODEL_EXPANSION_DESIGN.md` — Quintessential type expansion plan. The "Three-Layer Work Breakdown" section maps directly to manifest tracks.

- **lightcone** `docs/dev/PRODUCT_ARC.md` — Four-phase product roadmap. Each phase becomes a manifest phase entity; each phase's work items become capabilities and issues.

- **escapement** `docs/CONTEXT_PATH.md` — The context-path system that the manifest lives alongside. Archive paths in the manifest reference the same directory structure.

- **escapement** `docs/WORKFLOW.md` — The existing sequential workflow that the manifest orchestration layer sits above without replacing.

---

## 13. Implementation Sequence

**Phase A: Foundation** (MVP)
1. PGlite schema setup and seed script
2. Core queries (frontier, conflict detection, progress)
3. `manifest-bootstrap` skill — reads issues, produces graph, Q&A for ambiguities
4. `manifest-plan` skill — outputs dispatch plan from current state
5. `manifest-sync` skill — marks nodes done, records archive paths

**Phase B: Orchestration**
6. `manifest-dispatch` skill — creates worktrees, launches parallel sessions
7. Agent constraint templates (positive/negative file scope per agent)
8. `manifest-check` skill — reconciliation, drift detection, disambiguation propagation
9. Merge order coordination

**Phase C: Codebase Awareness** (Post-MVP)
10. isomorphic-git integration for file tracking
11. Live cross-branch conflict detection during parallel work
12. File set prediction from git history of similar PRs
13. Entity changelog for structural change tracking

---

*Captured from architectural discussion during Escapement v4.0 design phase.*
*Contributors: Marc Christophe, Claude*
