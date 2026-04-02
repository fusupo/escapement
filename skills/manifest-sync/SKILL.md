---
name: manifest-sync
description: Sync the manifest after work is completed. Marks work items done, records archive paths, reconciles predicted vs actual files, and recomputes the frontier. Invoke when user says "sync the manifest", "mark work done", "update manifest after merge", "manifest sync", or after archiving completed work.
tools:
  - mcp__github__*
  - Bash:node *
  - Bash:git *
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# Manifest Sync Skill

## Purpose

Synchronize the manifest after a work item is completed. This is the closure step in the manifest lifecycle: it marks a work item `done`, records what actually changed (vs what was predicted), links to the archive, cleans up stale metadata, and recomputes which work is now dispatchable.

Reference: `docs/MANIFEST_SYSTEM_DESIGN_V2.md` Sections 13.1-13.3

## Natural Language Triggers

- "Sync the manifest"
- "Mark work done"
- "Update manifest after merge"
- "Manifest sync"
- "Close out this work item in the manifest"
- After PR merge + archive: "Manifest is out of date"

## Arguments

The skill accepts optional arguments:

- **Work item ID:** The manifest entity ID (e.g., `esc#39`) or issue number (e.g., `#39` or `39`).
  If omitted, the skill infers from the current branch or asks the user.
- **`--pr N`:** Specify a PR number to read actual files from (otherwise inferred from branch).

Examples:
```
sync the manifest for #39
manifest sync esc#39
mark esc#39 done
manifest sync --pr 42
```

---

## Phase 0: Preconditions Check

**Goal:** Verify the manifest infrastructure is ready and identify the target work item.

### 0.1 Detect Context Path

Read the project's `CLAUDE.md` and extract the `context-path` setting:

```bash
grep -E '^\s*-\s*\*\*context-path\*\*' CLAUDE.md
```

The manifest database lives at `{context-path}/manifest/manifest.db`.

### 0.2 Verify Manifest CLI

Confirm the manifest CLI and database exist:

```bash
# Check CLI exists
ls manifest/manifest-cli.ts

# Check database exists
ls {context-path}/manifest/manifest.db
```

If database does not exist:
```
No manifest database found at {context-path}/manifest/manifest.db.
Run manifest-bootstrap first to initialize the manifest.
```
**Stop.**

### 0.3 Resolve Target Work Item

Determine which work item to sync. Resolution order:

1. **Explicit argument:** If user provided an entity ID or issue number, use it directly.

2. **Infer from branch:** Parse the current branch name for an issue number:
   ```bash
   git branch --show-current
   # e.g., "39-manifest-sync-skill" -> issue 39
   ```

3. **Ask user:** If neither works:
   ```
   AskUserQuestion:
     question: "Which work item should I mark as done?"
     header: "Work Item"
     options:
       - label: "Enter ID"
         description: "I'll provide the manifest entity ID (e.g., esc#39)"
   ```

### 0.4 Verify Work Item Exists

Query the manifest to confirm the item exists and check its current state:

```bash
node --import tsx manifest/manifest-cli.ts query "SELECT id, name, state, predicted_files, actual_files, archive_path FROM work_items WHERE id = '{item_id}'"
```

If state is already `done`:
```
Work item {item_id} is already marked done.

Current state:
  archive_path: {path}
  actual_files: {files}

Re-sync anyway?
```

```
AskUserQuestion:
  question: "This item is already done. Re-sync?"
  header: "Already Done"
  options:
    - label: "Re-sync"
      description: "Update actual files, archive path, and recompute frontier"
    - label: "Skip"
      description: "Nothing to do"
```

---

## Phase 1: Mark Work Item Done

**Goal:** Set the work item state to `done`.

### 1.1 Generate and Apply State Update

```sql
UPDATE work_items
SET state = 'done',
    updated_at = now()
WHERE id = '{item_id}';
```

Apply via the manifest CLI:

```bash
node --import tsx manifest/manifest-cli.ts query "UPDATE work_items SET state = 'done', updated_at = now() WHERE id = '{item_id}'"
```

### 1.2 Confirm

```
Marked {item_id} ({item_name}) as done.
```

---

## Phase 2: Populate Actual Files

**Goal:** Record which files were actually changed, and compare against predictions.

### 2.1 Determine Actual Files

Detect actual files from one of these sources (in priority order):

**Option A — Merged PR:**
If a PR number is known (from argument or branch):

```bash
# Find merged PR for this branch
gh pr list --head "{branch_name}" --state merged --json number,mergedAt --limit 1
```

If found:
```bash
# Get files changed in the PR
gh pr diff {pr_number} --name-only
```

**Option B — Git diff against base branch:**
If no merged PR, use git diff:

```bash
# Diff against the base branch (main or the branch this was created from)
git diff --name-only origin/main...HEAD
```

**Option C — Ask user:**
If neither works:
```
AskUserQuestion:
  question: "I couldn't detect the changed files automatically. How should I determine actual files?"
  header: "Actual Files"
  options:
    - label: "From PR #{N}"
      description: "Read files from a specific PR"
    - label: "From git diff"
      description: "Diff current branch against main"
    - label: "I'll provide them"
      description: "Let me list the files manually"
```

### 2.2 Apply Actual Files

```bash
node --import tsx manifest/manifest-cli.ts query "UPDATE work_items SET actual_files = ARRAY['{file1}', '{file2}'], updated_at = now() WHERE id = '{item_id}'"
```

**SQL Safety:** Escape single quotes in file paths.

### 2.3 Reconcile Predicted vs Actual

Compare `predicted_files` with `actual_files`:

```bash
node --import tsx manifest/manifest-cli.ts query "SELECT predicted_files, actual_files FROM work_items WHERE id = '{item_id}'"
```

Compute:
- **Correct predictions:** files in both predicted and actual
- **Missed files:** files in actual but not predicted (underestimation)
- **False predictions:** files in predicted but not actual (overestimation)
- **Accuracy:** correct / (correct + missed + false)

Display reconciliation:

```
File reconciliation for {item_id}:

  Predicted: {predicted_count} files
  Actual:    {actual_count} files
  Accuracy:  {percentage}%

  Correct:   {list}
  Missed:    {list}   <- files changed but not predicted
  False:     {list}   <- files predicted but not changed
```

### 2.4 Record Drift in Meta

If accuracy is below 100%, record drift metadata for future planning improvement:

```sql
UPDATE work_items
SET meta = jsonb_set(
  meta,
  '{file_reconciliation}',
  '{
    "accuracy_pct": {accuracy},
    "missed_count": {missed_count},
    "false_count": {false_count},
    "missed_files": ["{file1}", "{file2}"],
    "false_files": ["{file1}", "{file2}"]
  }'::jsonb
),
updated_at = now()
WHERE id = '{item_id}';
```

---

## Phase 3: Record Archive Path

**Goal:** Link the work item to its archive location in Escapement's context-path system.

### 3.1 Detect Archive Path

The archive is produced by `archive-work` and follows this structure:

```
{context-path}/{branch}/
  README.md
  SCRATCHPAD_{issue}.md
  SESSION_LOG_*.md
```

Search for the archive:

```bash
# Look for the archive directory matching the branch name
ls -d {context-path}/{branch_name}/ 2>/dev/null

# Also check for the branch with issue number
ls -d {context-path}/*{issue_number}*/ 2>/dev/null
```

If found, read the archive README to confirm it matches:

```bash
head -5 {context-path}/{branch_name}/README.md
```

### 3.2 Handle Missing Archive

If no archive found:

```
AskUserQuestion:
  question: "No archive found for this work item. Has archive-work been run?"
  header: "Archive"
  options:
    - label: "Run archive-work first"
      description: "I'll archive the work, then re-run manifest-sync"
    - label: "Set path manually"
      description: "I'll provide the archive path"
    - label: "Skip archive"
      description: "Leave archive_path empty for now"
```

### 3.3 Apply Archive Path

```bash
node --import tsx manifest/manifest-cli.ts query "UPDATE work_items SET archive_path = '{archive_path}', updated_at = now() WHERE id = '{item_id}'"
```

**Archive Integration Contract (V2 Section 13.3):**
The manifest only records the path. It does NOT:
- Create archive directories
- Generate archive README
- Move session logs
- Update INDEX.md

Those responsibilities belong to `archive-work`.

---

## Phase 4: Clear Stale Metadata

**Goal:** Remove ambiguity metadata that is no longer relevant now that the work is done.

### 4.1 Clear Ambiguity Flags

Remove `needs_human`, `ambiguity_questions`, `ambiguities`, and `bootstrap_status` from the meta JSONB field:

```bash
node --import tsx manifest/manifest-cli.ts query "UPDATE work_items SET meta = meta - 'needs_human' - 'ambiguity_questions' - 'ambiguities' - 'bootstrap_status', updated_at = now() WHERE id = '{item_id}'"
```

### 4.2 Clean Up Resolved Edges

If there were ambiguous edges involving this item, upgrade their confidence:

```bash
node --import tsx manifest/manifest-cli.ts query "UPDATE edges SET confidence = 'certain' WHERE (from_id = '{item_id}' OR to_id = '{item_id}') AND confidence = 'ambiguous'"
```

---

## Phase 5: Recompute and Display Frontier

**Goal:** Find which work items are now dispatchable after this completion.

### 5.1 Identify Newly Unblocked Items

Query for items that depended on the just-completed work and now have all dependencies satisfied:

```bash
node --import tsx manifest/manifest-cli.ts query "
  SELECT wi.id, wi.name
  FROM edges e
  JOIN work_items wi ON wi.id = e.from_id
  WHERE e.rel = 'depends_on'
    AND e.to_id = '{item_id}'
    AND wi.state = 'planned'
    AND NOT EXISTS (
      SELECT 1 FROM edges e2
      JOIN work_items dep ON dep.id = e2.to_id
      WHERE e2.rel = 'depends_on'
        AND e2.from_id = wi.id
        AND dep.state != 'done'
    )
"
```

### 5.2 Compute Full Frontier

Run the frontier query (V2 Section 9.2):

```bash
node --import tsx manifest/manifest-cli.ts frontier
```

If the CLI does not have a `frontier` command, run the query directly:

```bash
node --import tsx manifest/manifest-cli.ts query "
  SELECT w.id, w.name, w.kind, w.repo, w.scope_hint, w.predicted_files
  FROM work_items w
  WHERE w.kind IN ('issue', 'capability')
    AND w.state = 'planned'
    AND COALESCE((w.meta->>'needs_human')::boolean, false) = false
    AND NOT EXISTS (
      SELECT 1 FROM edges e
      JOIN work_items dep ON dep.id = e.to_id
      WHERE e.rel = 'depends_on'
        AND e.from_id = w.id
        AND dep.state != 'done'
    )
"
```

### 5.3 Check for File Overlaps in New Frontier

If multiple items entered the frontier, check for file overlap:

```bash
node --import tsx manifest/manifest-cli.ts query "
  WITH frontier AS (
    SELECT id, predicted_files
    FROM work_items
    WHERE kind IN ('issue', 'capability')
      AND state = 'planned'
      AND cardinality(predicted_files) > 0
      AND COALESCE((meta->>'needs_human')::boolean, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        JOIN work_items dep ON dep.id = e.to_id
        WHERE e.rel = 'depends_on'
          AND e.from_id = work_items.id
          AND dep.state != 'done'
      )
  )
  SELECT a.id AS node_a, b.id AS node_b,
    ARRAY(
      SELECT shared_file FROM (
        SELECT unnest(a.predicted_files) AS shared_file
        INTERSECT
        SELECT unnest(b.predicted_files) AS shared_file
      ) s ORDER BY shared_file
    ) AS shared_files
  FROM frontier a
  JOIN frontier b ON a.id < b.id
  WHERE a.predicted_files && b.predicted_files
"
```

---

## Phase 6: Output Summary

**Goal:** Give the user a clear picture of what changed and what is now available.

### 6.1 Display Sync Report

```
Manifest sync complete for {item_id} ({item_name}):

  State:        done
  Actual files: {actual_count} files
  Archive:      {archive_path or "not set"}
  Prediction accuracy: {accuracy}% ({correct}/{total})
  Stale metadata: cleared

Newly unblocked:
  {id}: {name}
  {id}: {name}
  (none — no items were waiting on this)

Updated frontier ({count} dispatchable):
  {id}: {name}
  {id}: {name}
  ...

File overlaps in frontier:
  {node_a} <-> {node_b}: {shared_files}
  (none — all frontier items have isolated file sets)
```

### 6.2 Suggest Next Steps

```
Next steps:
  - Run `setup-work` on newly unblocked items to begin implementation
  - Run `manifest status` to see overall progress
  - Run `manifest-check` to validate graph health (when available)
```

---

## Error Handling

### Work Item Not Found
```
Work item '{item_id}' not found in the manifest.

Available items:
  {list from manifest status}

Check the ID format: should be {repo_short}#{number} (e.g., esc#39)
```

### No Manifest Database
```
No manifest database found. Run manifest-bootstrap first.
```

### PR Not Found
```
Could not find a merged PR for branch '{branch}'.
Use --pr N to specify the PR number, or I can use git diff instead.
```

### Archive Not Found
The skill handles this gracefully in Phase 3.2 — it asks the user and allows skipping.

### CLI Failures
If `manifest-cli.ts query` fails:
- Display the error
- Show the SQL that failed
- Offer to retry or skip that step

---

## Integration

**Invokes:**
- `manifest-cli.ts query` — apply SQL updates
- `manifest-cli.ts frontier` — recompute dispatchable items
- `manifest-cli.ts status` — overall manifest state
- `gh pr` — read PR file changes

**Invoked after:**
- `archive-work` — once work is archived, sync the manifest
- PR merge — sync manifest to reflect completion
- Manual completion — user marks work done

**Flows to:**
- `setup-work` — begin work on newly unblocked frontier items
- `manifest-check` — validate graph health (when available)

---

**Version:** 1.0.0
**Last Updated:** 2026-03-31
**Maintained By:** Escapement
