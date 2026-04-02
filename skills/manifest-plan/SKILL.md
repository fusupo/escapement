---
name: manifest-plan
description: Generate a dispatch plan from the manifest frontier. Queries dispatchable work items, detects file overlaps, classifies conflicts, and outputs parallel dispatch groups. Invoke when user says "plan the manifest", "generate dispatch plan", "what can run in parallel", "manifest plan", or "plan work dispatch".
tools:
  - Bash:node *
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# Manifest Plan Skill

## Purpose

Query the manifest frontier for dispatchable work items, detect file overlaps across those items, classify conflicts with LLM judgment, and output a structured `DispatchPlan` showing what can safely run in parallel.

Reference: `docs/MANIFEST_SYSTEM_DESIGN_V2.md` Section 11

## Natural Language Triggers

- "Plan the manifest"
- "Generate dispatch plan"
- "What can run in parallel?"
- "Manifest plan"
- "Plan work dispatch"
- "Show me the dispatch plan"

---

## Phase 0: Preconditions Check

### 0.1 Verify Manifest Infrastructure

Confirm the manifest CLI and database are operational:

```bash
node --import tsx manifest/manifest-cli.ts status
```

If this fails, report:
```
Manifest infrastructure not ready. Run `manifest-bootstrap` first.
```

### 0.2 Check for Seeded Data

If the status command shows 0 items, the manifest has no data:
```
No work items in the manifest. Run `manifest-bootstrap` to populate it.
```

---

## Phase 1: Query Frontier and Overlaps

### 1.1 Run the Plan Command

Use the manifest CLI to generate the dispatch plan:

```bash
node --import tsx manifest/manifest-cli.ts plan
```

This command:
1. Queries all dispatchable frontier items (planned, no unmet deps, no human gate)
2. Detects file overlaps across frontier items
3. Groups items by repo
4. Identifies shared files between items in the same repo group

### 1.2 Review the Raw Plan Output

The CLI outputs:
- Frontier item count
- Overlap pairs with shared files
- Repo-grouped items with their predicted files

---

## Phase 2: Conflict Classification

**This is the LLM-driven phase.** The CLI identifies shared files but cannot classify them -- that requires understanding what each file does.

### 2.1 For Each Shared File Pair

For every overlap pair reported by the CLI:

1. **Read the shared file(s)** to understand their purpose
2. **Classify each shared file** using these categories:

| Classification | Criteria | Safe to Parallelize? |
|---|---|---|
| `trivial` | Barrel exports, generated indexes, one-line registrations | Yes |
| `additive` | Independent cases/sections in the same file | Yes (with merge order) |
| `semantic` | Same function, same control path, same domain logic | No |
| `unknown` | Overlap exists but confidence is not high enough | No (conservative) |

3. **Assess confidence**: `certain`, `inferred`, or `ambiguous`
4. **Add notes** explaining the classification rationale

### 2.2 Classification Rules

- **Err on the side of `unknown`** when uncertain
- A single `semantic` or `unknown` shared file between two items means they should NOT be in the same parallel group
- `trivial` shared files are ignored for grouping purposes
- `additive` shared files are safe but require explicit merge order

---

## Phase 3: Build Parallel Groups

### 3.1 Partition by Repo

Group frontier items by their `repo` field. Items in different repos never conflict.

### 3.2 Partition by Overlap

Within each repo group:
- Items with no shared files -> can all run in parallel
- Items sharing only `trivial` files -> can run in parallel
- Items sharing `additive` files -> can run in parallel but need merge order
- Items sharing `semantic` or `unknown` files -> must be in separate groups or run sequentially

### 3.3 Determine Merge Order

For items sharing `additive` files within a parallel group:
- Read the shared file to understand its structure
- Determine which item's changes should merge first
- Record the merge order in the group

### 3.4 Identify Sequential (Blocked) Items

Items that are NOT on the frontier (have unmet dependencies) are listed as sequential nodes with:
- The IDs they are blocked by
- A human-readable reason

---

## Phase 4: Emit Validation Policy

Based on the items in the dispatch plan:

- **max_concurrent_node_heavy_tasks**: Default to 2 (Node.js processes are memory-intensive)
- **serialized_checks**: List checks that must not run in parallel (e.g., `["typescript-build", "integration-tests"]`)

Adjust based on:
- Number of items that involve Node.js/TypeScript work
- Whether items share test infrastructure
- Resource constraints mentioned in CLAUDE.md

---

## Phase 5: Assemble and Present DispatchPlan

### 5.1 Build Summary

```
Dispatch Plan Summary:
  Frontier items: {count}
  Dispatchable now: {count}
  Blocked: {count}
  Human-gated: {count}
```

### 5.2 Present Parallel Groups

For each parallel group:

```
Parallel Group: {repo}
  Items: {count}

  {id}: {name}
    Branch: {branch}
    Files owned: {list}
    Shared files:
      {path} -- {assessment} ({confidence}): {notes}
    Forbidden files: {list}

  Merge order: {id1} -> {id2} -> ...
```

### 5.3 Present Sequential Items

```
Sequential (blocked):
  {id}: {name}
    Blocked by: {blocker_ids}
    Reason: {reason}
```

### 5.4 Present Validation Policy

```
Validation Policy:
  Max concurrent Node-heavy tasks: {N}
  Serialized checks: {list}
```

### 5.5 Assumptions

List any assumptions made during planning:
```
Assumptions:
  - {assumption1}
  - {assumption2}
```

---

## Phase 6: Next Steps

```
Next steps:
  - Run `manifest-dispatch` to execute the plan (when available)
  - Use `setup-work` on individual frontier items
  - Re-run `manifest-plan` after completing items to refresh
```

---

## Error Handling

### No Frontier Items
```
No dispatchable items on the frontier. All items are either:
  - Done
  - Blocked by unmet dependencies
  - Human-gated (needs_human = true)

Run `manifest status` to see the full picture.
```

### No Overlaps
```
No file overlaps detected. All frontier items can run in parallel safely.
```

This is the simplest case -- every item gets its own parallel group.

---

## Integration

**Invokes:**
- `manifest-cli.ts plan` -- query frontier and overlaps
- `manifest-cli.ts frontier` -- fallback frontier view
- `manifest-cli.ts status` -- verify manifest state

**Invoked by:**
- User directly via natural language triggers
- After `manifest-bootstrap` completes
- Before `manifest-dispatch` begins

**Reads from:**
- Manifest SQLite database (via CLI)
- Shared files in the codebase (for conflict classification)
- Project CLAUDE.md (for resource constraints)

---

**Version:** 1.0.0
**Last Updated:** 2026-03-31
**Maintained By:** Escapement
