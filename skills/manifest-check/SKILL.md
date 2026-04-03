---
name: manifest-check
description: Ad-hoc manifest health check — reconcile predictions vs actuals, detect superseded items, ingest new issues, re-run overlap analysis, and surface drift. Invoke when user says "check the manifest", "manifest health check", "reconcile the manifest", "recheck the manifest", "manifest drift", or "manifest status check".
tools:
  - mcp__github__*
  - mcp__serena__*
  - Bash:node *
  - Bash:mkdir *
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - Task
  - LSP
---

# Manifest Check Skill

## Purpose

Run an ad-hoc health check on the manifest: detect superseded in-progress items, reconcile predicted vs actual file sets for completed work, ingest newly filed issues, re-run file overlap analysis, and record drift patterns for future planning conservatism.

Reference: `docs/MANIFEST_SYSTEM_DESIGN_V2.md` Section 13.4

## Natural Language Triggers

- "Check the manifest"
- "Manifest health check"
- "Reconcile the manifest"
- "Recheck the manifest"
- "Manifest drift"
- "Manifest status check"
- "Run manifest check"

## Arguments

The skill accepts optional arguments:

- **Repo(s):** One or more repositories in `owner/repo` format. If omitted, infers from `git remote get-url origin`.
- **`--writeback`:** Enable GitHub write-back mode for reconciliation comments.

Examples:
```
check the manifest
manifest health check for fusupo/escapement
recheck the manifest --writeback
```

---

## Phase 0: Preconditions

**Goal:** Verify manifest infrastructure is ready.

### 0.1 Detect Context Path

Read the project's `CLAUDE.md` and extract the `context-path` setting:

```bash
grep -E '^\s*-\s*\*\*context-path\*\*' CLAUDE.md
```

The manifest database lives at `{context-path}/manifest/manifest.db`.

### 0.2 Verify Manifest CLI

```bash
ls manifest/manifest-cli.ts
ls manifest/node_modules/.package-lock.json
```

If `node_modules` is absent, stop and ask user to run `cd manifest && npm install`.

### 0.3 Verify Database Exists

```bash
ls {context-path}/manifest/manifest.db
```

If no database exists, this skill cannot run -- the manifest must be bootstrapped first:

```
No manifest database found. Run manifest-bootstrap first to initialize.
```

### 0.4 Current Status Baseline

```bash
node --import tsx manifest/manifest-cli.ts status
```

Display the baseline before making any changes.

---

## Phase 1: Supersession Detection

**Goal:** Identify `in_progress` items that may be superseded by newer items with overlapping scope.

### 1.1 Run Supersession Check

```bash
node --import tsx manifest/manifest-cli.ts check superseded
```

This queries all `in_progress` items and compares their `predicted_files` and `scope_hint` against newer `planned` or `in_progress` items. If a newer item covers the same files or references the same scope, the older item is flagged as potentially superseded.

### 1.2 Present Findings

Display superseded candidates to the user:

```
Supersession Check:

Potentially superseded items:
  {id}: {name}
    Newer item: {newer_id} ({newer_name})
    Shared files: {file_list}
    Recommendation: {mark deferred / keep / needs review}
```

### 1.3 Collect Decisions

For each superseded candidate:

```
AskUserQuestion:
  question: "{id}: {name}\n\nPotentially superseded by {newer_id}: {newer_name}\nShared files: {files}"
  header: "Superseded?"
  options:
    - label: "Mark deferred"
      description: "This item is superseded; defer it"
    - label: "Keep in_progress"
      description: "Still actively working on this"
    - label: "Mark cancelled"
      description: "No longer needed at all"
```

### 1.4 Apply Decisions

For deferred/cancelled items, update via CLI:

```bash
node --import tsx manifest/manifest-cli.ts check apply-superseded {id} {new_state}
```

---

## Phase 2: Reconciliation

**Goal:** Compare predicted vs actual file sets for completed items to measure prediction accuracy.

### 2.1 Run Reconciliation

```bash
node --import tsx manifest/manifest-cli.ts check reconcile
```

This finds all `done` items that have both `predicted_files` and `actual_files` populated, then computes:
- **Hits:** Files in both predicted and actual
- **Misses:** Files in actual but not predicted
- **False positives:** Files in predicted but not actual
- **Accuracy:** hits / (hits + misses + false_positives)

### 2.2 Display Results

```
Reconciliation Results:

  {id}: {name}
    Predicted: {count} files
    Actual:    {count} files
    Hits:      {count} ({pct}%)
    Misses:    {count} — {file_list}
    False pos: {count} — {file_list}

  Overall accuracy: {pct}%
```

### 2.3 Record Reconciliation

Results are stored in `meta.reconciliation` on each item:

```json
{
  "reconciliation": {
    "hits": ["file1.ts"],
    "misses": ["file2.ts"],
    "false_positives": ["file3.ts"],
    "accuracy": 0.75,
    "checked_at": "2026-03-31T..."
  }
}
```

---

## Phase 3: Issue Ingestion

**Goal:** Discover newly filed issues that are not yet in the manifest and ingest them.

### 3.1 Fetch Current Issues

Determine the target repo (from args or `git remote get-url origin`).

```
mcp__github__list_issues:
  owner: {owner}
  repo: {repo}
  state: "open"
  perPage: 100
```

### 3.2 Compare Against Manifest

```bash
node --import tsx manifest/manifest-cli.ts check new-issues
```

This lists all `issue_number` values currently in the manifest for the repo. Any open GitHub issue not present is a candidate for ingestion.

### 3.3 Present New Issues

```
New Issues Not in Manifest:

  #{number}: {title}
  #{number}: {title}
  ...

Ingest these into the manifest?
```

```
AskUserQuestion:
  question: "Found {N} issues not in the manifest. Ingest them?"
  header: "New Issues"
  options:
    - label: "Ingest all"
      description: "Add all new issues with full prediction"
    - label: "Select individually"
      description: "Choose which issues to add"
    - label: "Skip"
      description: "Don't ingest new issues now"
```

### 3.4 Ingest Selected Issues

For each issue to ingest, follow the same pattern as manifest-bootstrap Phase 4-6:
1. Create work item with `planned` state
2. Infer dependencies from issue body
3. Predict affected files via codebase analysis
4. Create edges (depends_on, is_part_of)

Generate and apply SQL via:

```bash
node --import tsx manifest/manifest-cli.ts seed {context-path}/manifest/check-ingest.sql
```

---

## Phase 4: Overlap Re-run

**Goal:** Re-execute file overlap analysis across the current frontier.

### 4.1 Run Overlap Query

```bash
node --import tsx manifest/manifest-cli.ts check overlap
```

This re-runs the `manifest/queries/overlap.sql` query against the current frontier.

### 4.2 Display Results

```
File Overlap Analysis (current frontier):

  {node_a} <-> {node_b}: {shared_files}
  ...

No overlaps: {count} items have isolated file sets
Total frontier items: {count}
```

---

## Phase 5: Drift Recording

**Goal:** When the same files appear repeatedly in prediction misses, record drift patterns for future conservatism.

### 5.1 Analyze Drift

```bash
node --import tsx manifest/manifest-cli.ts check drift
```

This examines all reconciliation data across completed items. Files that appear as misses in multiple items are "drift files" -- the prediction model consistently fails to predict them.

### 5.2 Display Drift Patterns

```
Drift Analysis:

Frequently missed files (appeared in 2+ reconciliation misses):
  {file}: missed in {count} items ({id_list})
  ...

These files should be included in future predictions more aggressively.
```

### 5.3 Record Drift

Drift patterns are stored in `meta.drift_patterns` on affected items:

```json
{
  "drift_patterns": {
    "files": ["config.ts", "index.ts"],
    "frequency": 3,
    "recorded_at": "2026-03-31T..."
  }
}
```

---

## Phase 6: Write-Back (Optional)

**Goal:** Prepare GitHub issue comments with reconciliation results.

Only runs if `--writeback` was passed or user requests it.

### 6.1 Prepare Payloads

For items with reconciliation results, prepare comment blocks:

```markdown
### Manifest Check Results

**Prediction Accuracy:** {pct}%
- Hits: {file_list}
- Misses: {file_list}
- False positives: {file_list}

**Drift files in this area:** {drift_file_list}

---
*Generated by manifest-check on {date}*
```

### 6.2 Confirm and Apply

Same confirmation flow as manifest-bootstrap Phase 8.

---

## Phase 7: Summary

### 7.1 Final Status

```bash
node --import tsx manifest/manifest-cli.ts status
```

### 7.2 Display Summary

```
Manifest Check Complete!

Supersession:
  Checked: {count} in_progress items
  Superseded: {count} (deferred: {n}, cancelled: {n}, kept: {n})

Reconciliation:
  Checked: {count} done items
  Overall accuracy: {pct}%

New Issues:
  Discovered: {count}
  Ingested: {count}

Overlap:
  Frontier items: {count}
  Overlapping pairs: {count}

Drift:
  Drift files detected: {count}
  Items updated: {count}

Write-back: {applied/prepared/skipped}
```

---

## Error Handling

### No Manifest Database
```
No manifest database found at {context-path}/manifest/manifest.db.
Run manifest-bootstrap first to initialize.
```

### No Completed Items for Reconciliation
```
No completed items with both predicted and actual files.
Reconciliation skipped.
```

### No In-Progress Items
```
No in_progress items to check for supersession.
```

---

## Integration

**Invokes:**
- `manifest-cli.ts check` — all check subcommands
- `manifest-cli.ts seed` — for ingesting new issues
- `manifest-cli.ts status` — before/after status
- `manifest-cli.ts frontier` — frontier display

**Invoked by:**
- User directly via natural language triggers
- Periodic health checks during long development cycles

**Flows to:**
- `manifest-plan` — re-plan after ingesting new issues
- `manifest-bootstrap` — if major re-bootstrap needed

---

**Version:** 1.0.0
**Last Updated:** 2026-03-31
**Maintained By:** Escapement
