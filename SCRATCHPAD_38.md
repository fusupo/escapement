# Manifest: manifest-plan skill - #38

## Issue Details
- **Repository:** fusupo/escapement
- **GitHub URL:** https://github.com/fusupo/escapement/issues/38
- **State:** open
- **Labels:** manifest
- **Milestone:** none
- **Assignees:** none
- **Related Issues:**
  - Depends on: #37 (manifest-bootstrap skill) -- **open**, not yet complete
  - #37 depends on: #34 (core SQL queries), #35 (CLI wrapper)

## Description

Build the `manifest-plan` skill that queries the frontier, runs file overlap analysis, classifies conflicts, and outputs a structured dispatch plan.

## Acceptance Criteria
- [ ] Create `skills/manifest-plan/SKILL.md` with frontmatter
- [ ] Query frontier for dispatchable work items
- [ ] Run file overlap detection across frontier
- [ ] Classify overlaps as trivial / additive / semantic / unknown
- [ ] Group nodes into parallel dispatch groups partitioned by repo
- [ ] Determine merge order for additive conflicts
- [ ] Emit validation policy (max concurrent Node-heavy tasks, serialized checks)
- [ ] Output `DispatchPlan` structure (parallel groups, sequential nodes, summary)

## Branch Strategy
- **Base branch:** 33-manifest-system
- **Feature branch:** 38-manifest-plan-skill
- **Current branch:** worktree-agent-a1ed6bbc

## Implementation Checklist

### Setup
- [ ] Fetch latest from base branch
- [ ] Create and checkout feature branch `38-manifest-plan-skill` from `33-manifest-system`

### Implementation Tasks

- [ ] **Task 1: Create `skills/manifest-plan/SKILL.md` with frontmatter and skill instructions**
  - Files affected: `skills/manifest-plan/SKILL.md`
  - Why: Define the skill's identity, triggers, tool requirements, and behavioral instructions for Claude

- [ ] **Task 2: Implement frontier query function in manifest module**
  - Files affected: `manifest/queries.ts` (new or extend existing)
  - Why: The plan skill needs to fetch dispatchable work items -- planned items with no unmet dependencies and no human gate. Uses the SQL from V2 design doc Section 9.1.

- [ ] **Task 3: Implement file overlap detection function**
  - Files affected: `manifest/queries.ts`
  - Why: Discover potential file contention across frontier items using the SQL from V2 design doc Section 9.2. Returns pairs of nodes sharing predicted files.

- [ ] **Task 4: Implement conflict classification logic**
  - Files affected: `manifest/plan.ts` (new)
  - Why: Classify each shared file as trivial (barrel exports, registrations), additive (independent sections), semantic (same function/logic), or unknown. Per Section 11.3.

- [ ] **Task 5: Implement parallel group partitioning**
  - Files affected: `manifest/plan.ts`
  - Why: Group frontier nodes into parallel dispatch groups, partitioned first by repo and then by overlap assessment. Nodes with semantic or unknown overlaps should not be in the same parallel group.

- [ ] **Task 6: Implement merge order determination for additive conflicts**
  - Files affected: `manifest/plan.ts`
  - Why: When multiple nodes in a parallel group share additive files, determine the merge order so changes layer correctly.

- [ ] **Task 7: Implement validation policy emission**
  - Files affected: `manifest/plan.ts`
  - Why: Output resource constraints -- max concurrent Node-heavy tasks, which checks must be serialized. Per Section 11.4.

- [ ] **Task 8: Implement DispatchPlan assembly and output**
  - Files affected: `manifest/plan.ts`
  - Why: Assemble the final `DispatchPlan` structure combining parallel groups, sequential (blocked) nodes, validation policy, and summary stats. Matches the TypeScript interface from Section 11.2.

- [ ] **Task 9: Wire plan into CLI wrapper (if CLI exists from #35)**
  - Files affected: `manifest/cli.ts` or equivalent
  - Why: Allow `manifest plan` command to invoke the planning logic and print results.

- [ ] **Task 10: Add test for plan generation with mock data**
  - Files affected: `manifest/test-plan.ts` (new)
  - Why: Verify the planner correctly groups frontier items, classifies overlaps, and produces valid DispatchPlan output.

### Quality Checks
- [ ] TypeScript compiles without errors
- [ ] Test passes with `npx tsx manifest/test-plan.ts`
- [ ] Self-review for code quality
- [ ] Verify acceptance criteria met

### Documentation
- [ ] Update CLAUDE.md if new skill needs listing
- [ ] Add inline comments for complex classification logic

## Technical Notes

### Architecture Considerations

The manifest-plan skill operates at two levels:

1. **Skill layer** (`skills/manifest-plan/SKILL.md`): Defines when/how Claude invokes the planner. This is a prompt-driven skill that instructs Claude to use the manifest module's planning functions.

2. **Module layer** (`manifest/plan.ts`): The actual planning logic -- query frontier, detect overlaps, classify conflicts, build dispatch groups. This is TypeScript code using PGlite via `manifest/init.ts`.

The skill will likely instruct Claude to:
- Initialize the manifest DB via `initManifest()`
- Run the frontier query
- Run file overlap detection
- Use LLM judgment for conflict classification (trivial/additive/semantic/unknown) since this requires understanding file purposes
- Assemble and present the DispatchPlan

### Key Interfaces (from V2 Design Section 11.2)

```typescript
interface DispatchPlan {
  generated_at: string;
  assumptions: string[];
  parallel_groups: ParallelGroup[];
  sequential: SequentialNode[];
  validation_policy: {
    max_concurrent_node_heavy_tasks: number;
    serialized_checks: string[];
  };
  summary: {
    frontier_count: number;
    dispatchable_now: number;
    blocked_count: number;
    human_gate_count: number;
  };
}

interface ParallelGroup {
  repo: string;
  nodes: {
    id: string;
    name: string;
    branch: string;
    files_owned: string[];
    files_shared: {
      path: string;
      assessment: 'trivial' | 'additive' | 'semantic' | 'unknown';
      confidence: 'certain' | 'inferred' | 'ambiguous';
      notes: string;
    }[];
    files_forbidden: string[];
    issue_url?: string;
  }[];
  merge_order?: string[];
}

interface SequentialNode {
  id: string;
  name: string;
  blocked_by: string[];
  reason: string;
}
```

### Conflict Classification Policy (Section 11.3)
- **trivial**: barrel exports, generated indexes, one-line registrations
- **additive**: independent cases/sections in the same file
- **semantic**: same function, same control path, same domain logic
- **unknown**: overlap exists but confidence is not high enough

`unknown` should be treated conservatively -- do not group automatically.

### Implementation Approach

The skill is primarily a **prompt-based orchestration skill** with supporting TypeScript modules:

1. The SKILL.md instructs Claude to query the manifest DB and apply LLM-assisted classification
2. The `manifest/queries.ts` provides SQL query functions (frontier, overlap)
3. The `manifest/plan.ts` provides the grouping/partitioning/assembly logic
4. Claude's judgment is needed for conflict classification since it requires understanding what each file does

This hybrid approach (code for data access + LLM for classification) aligns with the V2 philosophy of keeping conflict classification as planning-time data, not durable graph truth.

### Potential Challenges

1. **Conflict classification accuracy**: Determining if a shared file is trivial vs semantic requires understanding the file's role. The skill should err on the side of `unknown` when uncertain.
2. **Dependency on #37**: The bootstrap skill populates the manifest data this skill reads. Without seeded data, the planner has nothing to plan. Testing may require manual data seeding.
3. **PGlite array operations**: The `predicted_files` array overlap query uses PostgreSQL-specific syntax (`&&`, `unnest`). PGlite compatibility needs verification (already set up in #33).

## Questions/Blockers

### Clarifications Needed
(All resolved -- see Decisions Made)

### Decisions Made

**Q: Output format for DispatchPlan?**
**A:** Markdown only -- human-readable output displayed in chat. No JSON artifact needed.

**Q: Conflict classification approach?**
**A:** LLM-driven -- Claude reads every shared file for accurate classification. No heuristic shortcuts.

### Blocked By
- #37 (manifest-bootstrap) is still open -- the planner needs seeded manifest data to operate on. However, the skill and module code can be written and tested with mock data independently.

### Assumptions Made
- The base branch for this work is `33-manifest-system` since all manifest work builds on that branch
- The `manifest/` directory structure from #33 (init.ts, schema.sql, package.json) is available
- PGlite supports the array overlap (`&&`) and `unnest` operations needed for the file overlap query

## Work Log

{To be filled during execution}

---
**Generated:** 2026-03-31
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/escapement/issues/38
