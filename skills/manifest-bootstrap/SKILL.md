---
name: manifest-bootstrap
description: Bootstrap a manifest dependency graph from open GitHub issues and codebase analysis. Invoke when user says "bootstrap the manifest", "build a manifest", "bootstrap the issue graph", "initialize the manifest", or when a repo has no manifest yet.
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

# Manifest Bootstrap Skill

## Purpose

Build a manifest dependency graph for a project by reading open GitHub issues, analyzing the codebase, inferring dependencies, and seeding a SQLite database. The result is a queryable graph that answers: *what work exists, what depends on what, and what can run now?*

Reference: `docs/MANIFEST_SYSTEM_DESIGN_V2.md` Sections 10.1-10.4

## Natural Language Triggers

- "Bootstrap the manifest"
- "Build a manifest"
- "Bootstrap the issue graph"
- "Initialize the manifest"
- First use on a repo with no manifest database

## Arguments

The skill accepts optional arguments:

- **Repo(s):** One or more repositories in `owner/repo` format. If omitted, infers from `git remote get-url origin`.
- **`--writeback`:** Enable GitHub write-back mode (still requires per-batch confirmation).

Examples:
```
bootstrap the manifest
bootstrap the manifest for fusupo/escapement
bootstrap the manifest for corpus-relica/systema-relica --writeback
```

---

## Phase 0: Preconditions Check

**Goal:** Verify the manifest infrastructure is ready before doing any work.

### 0.1 Detect Context Path

Read the project's `CLAUDE.md` and extract the `context-path` setting:

```bash
grep -E '^\s*-\s*\*\*context-path\*\*' CLAUDE.md
```

The manifest database lives at `{context-path}/manifest/manifest.db`.

### 0.2 Verify Manifest CLI

Confirm the manifest CLI and dependencies exist:

```bash
# Check CLI exists
ls manifest/manifest-cli.ts

# Check dependencies installed
ls manifest/node_modules/.package-lock.json
```

If `node_modules` is absent:
```
The manifest CLI dependencies are not installed.

Run: cd manifest && npm install
```

**Stop and ask user to install before proceeding.**

### 0.3 Ensure Database Directory

```bash
mkdir -p {context-path}/manifest
```

### 0.4 Test CLI

```bash
node --import tsx manifest/manifest-cli.ts status
```

If this fails, report the error and stop. If it succeeds (even with 0 items), the infrastructure is ready.

**Output:**
```
Manifest infrastructure verified:
  CLI: manifest/manifest-cli.ts
  Database: {context-path}/manifest/manifest.db
  Status: {item count} existing items
```

---

## Phase 1: Issue Ingestion and Classification

**Goal:** Read all open issues from target repo(s) and classify each one.

### 1.1 Determine Target Repos

If repos were provided as arguments, use those. Otherwise infer from git:

```bash
git remote get-url origin
```

Parse `owner/repo` from the remote URL. Derive `repo_short` for entity IDs (e.g., `fusupo/escapement` -> `esc`, `corpus-relica/systema-relica` -> `sr`).

Ask the user to confirm repo list and short names:

```
AskUserQuestion:
  question: "Confirm target repos and short names for entity IDs"
  header: "Repos"
  options:
    - label: "{owner/repo} -> {short}"
      description: "Entity IDs will be {short}#123"
    - label: "Add another repo"
      description: "I need to include additional repositories"
    - label: "Change short names"
      description: "I want different short prefixes"
```

### 1.2 Fetch Open Issues

For each target repo, use GitHub MCP to list all open issues:

```
mcp__github__list_issues:
  owner: {owner}
  repo: {repo}
  state: "open"
  perPage: 100
```

Page through all results if there are more than 100.

Also fetch recently closed issues (last 30 days) to capture work that may need `done` status in the manifest:

```
mcp__github__list_issues:
  owner: {owner}
  repo: {repo}
  state: "closed"
  perPage: 50
```

### 1.3 Classify Issues

For each issue, classify based on these heuristics:

| Classification | Criteria |
|---|---|
| **active** | Has description, recent activity (within 90 days), not labeled deferred/backlog/wontfix |
| **deferred** | Labeled `deferred`, `backlog`, `wontfix`, `low-priority`, or explicitly deferred in description |
| **stale** | No activity in >90 days AND no milestone AND no recent comments |
| **unclear** | No description or acceptance criteria, OR conflicting requirements in comments |

Also classify recently closed issues as:
| **done** | Closed with a merged PR or explicitly marked complete |

Read each issue's title, body, labels, milestone, and last activity date. Build a classification table:

```
Issue Classification Results ({N} issues across {M} repos):

ACTIVE ({count}):
  {repo_short}#{number}: {title}
  ...

DEFERRED ({count}):
  {repo_short}#{number}: {title} — Reason: {label or description match}
  ...

STALE ({count}):
  {repo_short}#{number}: {title} — Last activity: {date}
  ...

UNCLEAR ({count}):
  {repo_short}#{number}: {title} — Reason: {missing description / conflicting requirements}
  ...

DONE (recently closed, {count}):
  {repo_short}#{number}: {title} — Closed: {date}
  ...
```

---

## Phase 2: User Confirmation of Pruning Decisions

**Goal:** The user must confirm classifications before seeding. This prevents stale issues from polluting the graph.

### 2.1 Present Classification Summary

Display the classification table from Phase 1 to the user.

### 2.2 Collect Confirmation

```
AskUserQuestion:
  question: "Review the issue classifications. Active issues will be seeded into the manifest. Deferred/stale/unclear issues will be excluded (can be added later via re-bootstrap)."
  header: "Confirm Classifications"
  options:
    - label: "Approve all"
      description: "Classifications look correct, proceed with seeding"
    - label: "Reclassify some issues"
      description: "I want to change some classifications before proceeding"
    - label: "Show me details"
      description: "Let me review individual issue descriptions before deciding"
```

### 2.3 Handle Reclassification

If user wants to reclassify:

For each issue to reclassify, use AskUserQuestion:

```
AskUserQuestion:
  question: "{repo_short}#{number}: {title}\n\nCurrently classified as: {classification}\n\n{issue body preview}"
  header: "Reclassify"
  options:
    - label: "active"
      description: "Include in manifest as planned work"
    - label: "deferred"
      description: "Exclude from current planning horizon"
    - label: "stale"
      description: "No longer relevant"
    - label: "unclear"
      description: "Needs clarification before including"
    - label: "done"
      description: "Already completed"
```

Repeat until user approves the final classification set.

---

## Phase 3: Design Phase and Track Structure

**Goal:** Build the hierarchy scaffold that issues attach to. Phases and tracks come from design docs, not from issues themselves.

### 3.1 Read Design Documentation

Search for structure-defining documents:

```
Glob: "docs/**/*.md"
Glob: "ROADMAP.md"
Glob: "*.md" (root level)
```

Read any documents that describe phases, milestones, tracks, or project organization. Also check GitHub milestones:

```
mcp__github__list_issues:
  owner: {owner}
  repo: {repo}
  state: "open"
  # Look at milestone field in results
```

### 3.2 Propose Hierarchy

Based on design docs and milestones, propose a phase/track structure:

```
Proposed Manifest Hierarchy:

phase:name_1 — "{Phase 1 Name}"
  track:name_1:track_a — "{Track A Name}"
  track:name_1:track_b — "{Track B Name}"

phase:name_2 — "{Phase 2 Name}"
  track:name_2:track_c — "{Track C Name}"
  ...

Unassigned active issues (no clear track):
  {repo_short}#{number}: {title}
  ...
```

### 3.3 Confirm Hierarchy

```
AskUserQuestion:
  question: "Review the proposed phase/track hierarchy. Issues will be assigned to tracks via is_part_of edges."
  header: "Hierarchy"
  options:
    - label: "Approve"
      description: "Hierarchy looks correct"
    - label: "Modify"
      description: "I want to rename, add, or remove phases/tracks"
    - label: "Flat structure"
      description: "Skip hierarchy, just seed issues without phases/tracks"
```

If user modifies, collect changes and update the structure.

### 3.4 Map Issues to Tracks

For each active issue, determine which track it belongs to based on:
- Labels matching track names
- Milestone membership
- Issue body mentions of relevant areas
- Design doc references

Present the mapping for confirmation if any assignments are uncertain.

---

## Phase 4: Seed Work Items into SQLite

**Goal:** Generate SQL and apply it via the manifest CLI.

### 4.1 Generate Seed SQL

Build a SQL file with all confirmed work items. Follow the pattern from `manifest/seed.ts`:

```sql
-- Bootstrap seed generated {timestamp}
-- Repos: {repo list}
-- Active issues: {count}
-- Phases: {count}, Tracks: {count}

-- Phases
INSERT INTO work_items (id, name, kind, state) VALUES
  ('phase:{slug}', '{Phase Name}', 'phase', 'in_progress')
ON CONFLICT (id) DO NOTHING;

-- Tracks
INSERT INTO work_items (id, name, kind, state) VALUES
  ('track:{phase}:{slug}', '{Track Name}', 'track', 'planned')
ON CONFLICT (id) DO NOTHING;

-- Issues
INSERT INTO work_items (id, name, kind, state, repo, issue_number, issue_url, meta) VALUES
  (
    '{repo_short}#{number}',
    '{sanitized_title}',
    'issue',
    '{state}',
    '{owner/repo}',
    {number},
    'https://github.com/{owner}/{repo}/issues/{number}',
    '{{"bootstrap_status":"active","needs_human":false}}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;
```

**SQL Safety:**
- Escape single quotes in titles: replace `'` with `''`
- Escape any special characters in issue text
- Use `ON CONFLICT (id) DO NOTHING` for idempotency

**Entity ID Conventions (V2 Section 8):**

| Kind | Pattern | Example |
|---|---|---|
| Issue | `{repo_short}#{number}` | `sr#586` |
| Capability | `{slug}` | `deprecate_construct` |
| Phase | `phase:{slug}` | `phase:quint_infra` |
| Track | `track:{phase}:{slug}` | `track:phase1:dsl` |

**State Mapping:**
- Active open issues -> `planned`
- Issues with WIP PRs -> `in_progress`
- Recently closed issues -> `done`
- Deferred issues (if included) -> `deferred`

### 4.2 Write and Apply Seed File

Write the generated SQL to a temporary file:

```bash
# Write to context-path for persistence
Write: {context-path}/manifest/bootstrap-seed.sql
```

Apply via the manifest CLI:

```bash
node --import tsx manifest/manifest-cli.ts seed {context-path}/manifest/bootstrap-seed.sql
```

### 4.3 Verify Seeding

```bash
node --import tsx manifest/manifest-cli.ts status
```

Display the result:

```
Seed applied:
  Work items: {count} ({by kind breakdown})
  Status: {status output}
```

---

## Phase 5: Edge Inference

**Goal:** Build the dependency graph by inferring edges from issue text, design docs, and structural relationships.

### 5.1 Infer `is_part_of` Edges

From the Phase 3 track mapping, generate hierarchy edges:

```sql
-- Track -> Phase hierarchy
INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
  ('track:{phase}:{slug}', 'is_part_of', 'phase:{slug}', 'certain')
ON CONFLICT (from_id, rel, to_id) DO NOTHING;

-- Issue -> Track membership
INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
  ('{repo_short}#{number}', 'is_part_of', 'track:{phase}:{slug}', '{confidence}')
ON CONFLICT (from_id, rel, to_id) DO NOTHING;
```

Confidence for issue-to-track:
- `certain`: explicitly labeled or milestone-assigned
- `inferred`: matched by keyword/topic analysis
- `ambiguous`: unclear which track, or could belong to multiple

### 5.2 Infer `depends_on` Edges

Parse each issue's body and comments for dependency signals:

**Explicit patterns** (confidence: `certain`):
- "depends on #N" / "depends on owner/repo#N"
- "blocked by #N"
- "requires #N"
- "after #N"
- GitHub issue reference in "Dependencies" or "Blocked by" sections

**Implicit patterns** (confidence: `inferred`):
- "related to #N" where one issue clearly provides foundation for the other
- Milestone ordering suggests sequence
- Design doc describes sequential phases

**Ambiguous patterns** (confidence: `ambiguous`):
- "see also #N" where relationship is unclear
- Both issues touch same files but direction unclear

For each detected dependency:

```sql
INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
  ('{dependent}', 'depends_on', '{dependency}', '{confidence}')
ON CONFLICT (from_id, rel, to_id) DO NOTHING;
```

Mark ambiguous dependencies for Phase 7 Q&A:
- Set `meta.needs_human = true` on the dependent item
- Add to `meta.ambiguities` array

### 5.3 Infer `implemented_by` Edges

If capabilities are defined (abstract work items implemented by concrete issues):

```sql
INSERT INTO edges (from_id, rel, to_id, confidence) VALUES
  ('{capability_slug}', 'implemented_by', '{repo_short}#{number}', '{confidence}')
ON CONFLICT (from_id, rel, to_id) DO NOTHING;
```

### 5.4 Apply Edge SQL

Append all edge INSERT statements to the seed SQL or write a separate edges file:

```bash
Write: {context-path}/manifest/bootstrap-edges.sql
node --import tsx manifest/manifest-cli.ts seed {context-path}/manifest/bootstrap-edges.sql
```

### 5.5 Verify Edges

Run the frontier query to confirm the graph is connected:

```bash
node --import tsx manifest/manifest-cli.ts frontier
```

Display the frontier:

```
Dependency graph seeded:
  Edges: {count} ({by rel breakdown})
  Frontier: {count} dispatchable items

  {frontier table output}
```

---

## Phase 6: File Set Prediction

**Goal:** Predict which files each active issue will touch. This powers the overlap query for parallel dispatch planning.

### 6.1 Analyze Each Active Issue

For each active issue (state = `planned` or `in_progress`), predict affected files:

**Strategy:**
1. Read the issue title, body, and any linked PRs
2. Identify components/modules mentioned in the issue
3. Search the codebase for relevant files:

```
Grep: pattern from issue keywords
Glob: patterns matching mentioned modules
mcp__serena__find_symbol: for specific component references
```

4. Check if any closed issues with similar scope have `actual_files` recorded — use those as a reference

**Conservative approach:**
- Only include files you are confident about
- Prefer fewer, more accurate predictions over broad guesses
- Include files at the module/component level, not every possible transitive dependency

### 6.2 Generate File Prediction SQL

```sql
UPDATE work_items
SET predicted_files = ARRAY[
  '{file1}',
  '{file2}'
],
updated_at = now()
WHERE id = '{repo_short}#{number}';
```

**SQL Safety:** Escape single quotes in file paths.

### 6.3 Apply Predictions

```bash
Write: {context-path}/manifest/bootstrap-files.sql
node --import tsx manifest/manifest-cli.ts seed {context-path}/manifest/bootstrap-files.sql
```

### 6.4 Check for Overlaps

Run the overlap query to see predicted contention:

```sql
-- Read and execute manifest/queries/overlap.sql against the database
```

Or use the CLI if an overlap command is available. If not, report:

```
File predictions applied to {count} issues.

Predicted overlaps detected:
  {node_a} <-> {node_b}: {shared_files}
  ...

No overlaps: {count} issues have isolated file sets
```

---

## Phase 7: Structured Ambiguity Q&A

**Goal:** Surface all unresolved questions in a batched, structured format and collect decisions.

### 7.1 Collect Ambiguities

Query for all items with `needs_human = true` or ambiguous edges:

Items needing resolution include:
- Issues classified as `unclear` that were included anyway
- Dependency edges with `confidence = 'ambiguous'`
- Issues where track membership is uncertain
- File overlap pairs where conflict severity is unknown

### 7.2 Present Structured Questions

Format per V2 Section 10.3:

```
I need decisions for {N} items before the frontier is reliable:

1. {repo_short}#{number}: {title}
   Question: {specific question}

2. {repo_short}#{number}: {title}
   Question: {specific question}

3. ...
```

For each ambiguity, use AskUserQuestion with concrete options:

```
AskUserQuestion:
  question: "{repo_short}#{number}: {title}\n\n{question}"
  header: "Resolve Ambiguity"
  options:
    - label: "{Option A}"
      description: "{what this means for the graph}"
    - label: "{Option B}"
      description: "{what this means for the graph}"
    - label: "Defer"
      description: "Leave as ambiguous for now"
```

### 7.3 Apply Resolutions

After each answer, generate correction SQL:

```sql
-- Update confidence on resolved edge
UPDATE edges
SET confidence = 'certain'
WHERE from_id = '{id}' AND rel = 'depends_on' AND to_id = '{dep_id}';

-- Clear needs_human flag
UPDATE work_items
SET meta = jsonb_set(meta, '{needs_human}', 'false'),
    updated_at = now()
WHERE id = '{id}';

-- Remove from ambiguities array
UPDATE work_items
SET meta = meta - 'ambiguities',
    updated_at = now()
WHERE id = '{id}';
```

Apply via seed command after writing to a SQL file.

### 7.4 Skip Conditions

If no ambiguities exist:
```
No ambiguities to resolve. Frontier is reliable as-is.
```

Skip directly to Phase 8.

---

## Phase 8: GitHub Write-Back (Optional)

**Goal:** Prepare write-back payloads for GitHub issues, but only apply with explicit confirmation.

### 8.1 Check Write-Back Mode

Write-back is opt-in. Only proceed if:
- User passed `--writeback` argument, OR
- User explicitly requests write-back during the session

If not enabled:
```
GitHub write-back skipped (not requested).
To enable: re-run with --writeback or say "write back to GitHub"
```

Skip to Phase 9.

### 8.2 Prepare Payloads

For each active issue, prepare a write-back comment block:

```markdown
### Manifest Bootstrap Notes

**Dependencies:**
- Depends on: #{dep1}, #{dep2}
- Blocks: #{blocked1}

**Predicted Scope:**
- `{file1}`
- `{file2}`

**Overlap Notes:**
- Shares `{file}` with #{other} — assessment: {trivial/additive/semantic/unknown}

---
*Generated by manifest-bootstrap on {date}*
```

### 8.3 Save Payloads

Write all payloads to a JSON file for review:

```bash
Write: {context-path}/manifest/writeback-{timestamp}.json
```

Format:
```json
{
  "generated_at": "{timestamp}",
  "payloads": [
    {
      "repo": "{owner/repo}",
      "issue_number": {number},
      "comment_body": "{markdown comment}"
    }
  ]
}
```

### 8.4 Confirm and Apply

Present summary:

```
Prepared write-back for {N} issues:

  {repo_short}#{number}: {title} — deps: {count}, files: {count}
  ...

Apply these as GitHub issue comments?
```

```
AskUserQuestion:
  question: "Apply write-back comments to GitHub issues?"
  header: "Write-Back"
  multiSelect: true
  options:
    - label: "Apply all"
      description: "Post comments to all {N} issues"
    - label: "Select individually"
      description: "Choose which issues to write back to"
    - label: "Skip"
      description: "Don't apply, keep payload file for later"
```

If applying, use GitHub MCP for each selected issue:

```
mcp__github__add_issue_comment:
  owner: {owner}
  repo: {repo}
  issue_number: {number}
  body: {comment_body}
```

Update meta on each written-back item:

```sql
UPDATE work_items
SET meta = jsonb_set(
  jsonb_set(meta, '{writeback,last_prepared_at}', '"{timestamp}"'::jsonb),
  '{writeback,last_applied_at}', '"{timestamp}"'::jsonb
),
updated_at = now()
WHERE id = '{id}';
```

---

## Phase 9: Output Summary

**Goal:** Give the user a clear picture of the bootstrapped manifest.

### 9.1 Final Status

```bash
node --import tsx manifest/manifest-cli.ts status
node --import tsx manifest/manifest-cli.ts frontier
```

### 9.2 Display Summary

```
Manifest bootstrap complete!

Items seeded:
  Phases: {count}
  Tracks: {count}
  Issues: {count}
  Capabilities: {count}
  Total: {count}

State breakdown:
  planned: {count}
  in_progress: {count}
  done: {count}
  deferred: {count}

Dependency graph:
  Edges: {count} (depends_on: {n}, is_part_of: {n}, implemented_by: {n})
  Certain: {count}, Inferred: {count}, Ambiguous: {count}

File predictions:
  Issues with predictions: {count} of {total}
  Overlapping pairs: {count}

Frontier ({count} dispatchable):
  {frontier table}

Human gates remaining: {count}
Write-back: {applied/prepared/skipped}

SQL files:
  Seed: {context-path}/manifest/bootstrap-seed.sql
  Edges: {context-path}/manifest/bootstrap-edges.sql
  Files: {context-path}/manifest/bootstrap-files.sql
  Write-back: {context-path}/manifest/writeback-{timestamp}.json (if prepared)
```

### 9.3 Next Steps

```
Next steps:
  - Run `manifest frontier` to see dispatchable work
  - Run `manifest status` to check progress
  - Use `setup-work` on frontier items to begin implementation
  - Re-run `manifest-bootstrap` to ingest new issues (idempotent)
```

---

## Re-Bootstrap Safety

Because all seed SQL uses `INSERT ... ON CONFLICT (id) DO NOTHING`, re-running bootstrap on an existing manifest is safe:

- New issues are added
- Existing issues are not modified
- New edges are added
- Existing edges are not duplicated
- File predictions use UPDATE so they will refresh

To force a full rebuild, delete the SQLite database file and re-run:

```bash
rm -f {context-path}/manifest/manifest.db
manifest-bootstrap
```

---

## Error Handling

### No Open Issues
```
No open issues found in {repo}. Nothing to bootstrap.
```

### GitHub API Rate Limit
```
GitHub API rate limit reached. Try again in {minutes} minutes.
Alternatively, reduce scope by specifying a single repo.
```

### CLI Failures
If `manifest-cli.ts seed` fails:
- Display the error
- Save the SQL file for manual inspection
- Offer to retry or skip that step

### SQL Errors
If generated SQL has syntax issues:
- Display the failing statement
- Attempt to fix (usually quote escaping)
- Re-apply the corrected SQL

---

## Integration

**Invokes:**
- `manifest-cli.ts seed` — apply generated SQL
- `manifest-cli.ts frontier` — verify frontier after seeding
- `manifest-cli.ts status` — verify overall state

**Invoked by:**
- User directly via natural language triggers
- First use of manifest system on a project

**Flows to:**
- `manifest-plan` (when available) — plan parallel dispatch from the frontier
- `setup-work` — begin work on frontier items

---

**Version:** 1.0.0
**Last Updated:** 2026-03-31
**Maintained By:** Escapement
