---
name: manifest-dispatch
description: Dispatch parallel work from a manifest plan. Creates worktrees, branches, constraint blocks, and launches agent sessions. Invoke when user says "dispatch work", "launch parallel agents", "dispatch the plan", "run the dispatch", or "dispatch the frontier".
tools:
  - Bash:git *
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

# Manifest Dispatch Skill

## Purpose

Take a dispatch plan (from `manifest-plan`) and execute it: create worktrees, assign branches, generate file-ownership constraint blocks, batch-generate scratchpads, and launch parallel agent sessions via the Task tool.

Reference: `docs/MANIFEST_SYSTEM_DESIGN_V2.md` Section 12

## Natural Language Triggers

- "Dispatch work"
- "Launch parallel agents"
- "Dispatch the plan"
- "Run the dispatch"
- "Dispatch the frontier"
- "Start parallel work"

---

## Phase 0: Preconditions

Verify the environment is ready for dispatch.

### 0.1 Detect context-path

Read the project's `CLAUDE.md` and extract the Escapement Settings `context-path` value.

```bash
grep -A1 'context-path' CLAUDE.md
```

### 0.2 Verify manifest CLI

```bash
ls manifest/manifest-cli.ts
ls manifest/node_modules/.package-lock.json  # or node_modules exists
```

If `manifest/node_modules` is missing:

```
Warning: manifest dependencies not installed.
Run: cd manifest && npm install
```

### 0.3 Verify SQLite database

```bash
node --import tsx manifest/manifest-cli.ts status
```

If this errors, the database hasn't been initialized. Direct the user to run `manifest-bootstrap` first.

### 0.4 Verify frontier has dispatchable items

```bash
node --import tsx manifest/manifest-cli.ts frontier
```

If frontier is empty, report:

```
No dispatchable items on the frontier. Nothing to dispatch.
```

**STOP** -- nothing to do.

---

## Phase 1: Load and Present Dispatch Plan

### 1.1 Generate the plan

```bash
node --import tsx manifest/manifest-cli.ts plan
```

Capture the full output. The plan contains:
- **Parallel groups**: sets of items that can run concurrently
- **Nodes**: individual work items within each group, with owned/shared/forbidden files
- **Overlaps**: file conflicts between nodes
- **Validation policy**: resource constraints for parallel execution
- **Blocked items**: items waiting on unfinished dependencies
- **Human-gated items**: items needing manual input before dispatch

### 1.2 Present plan summary

Display a concise summary to the user:

```
Dispatch Plan Summary

Parallel Groups: {N}
  Group 1: {node_count} items
    - {id}: {name} ({owned_file_count} owned, {shared_file_count} shared)
    - {id}: {name} ...
  Group 2: ...

Blocked: {N} items (waiting on dependencies)
Human-gated: {N} items (need manual input)

Validation Policy:
  - {constraint 1}
  - {constraint 2}
```

---

## Phase 2: User Approval Gate

Before creating any worktrees or branches, get explicit confirmation.

```
AskUserQuestion:
  question: "Approve this dispatch plan? This will create {N} worktrees and branches."
  header: "Dispatch"
  options:
    - label: "Approve all"
      description: "Dispatch all {N} items in the plan"
    - label: "Select groups"
      description: "Choose which parallel groups to dispatch"
    - label: "Cancel"
      description: "Don't dispatch anything"
```

**If "Select groups":** Present each group and let the user pick which to include:

```
AskUserQuestion:
  question: "Which parallel groups should be dispatched?"
  header: "Groups"
  multiSelect: true
  options:
    - label: "Group 1"
      description: "{items in group 1}"
    - label: "Group 2"
      description: "{items in group 2}"
    ...
```

**If "Cancel":** STOP. Report no changes made.

---

## Phase 3: Worktree and Branch Creation

For each approved node in the selected parallel groups:

### 3.1 Compute paths

- **Worktree base**: Same directory as the project root's parent
- **Worktree path**: `{project-root}/../{repo-name}-worktrees/{branch-name}`
- **Branch name**: Use the convention from the manifest work item, or generate as `{issue_number}-{slugified-name}`

Example for `m#42` named "Fix login flow" in repo `fusupo/escapement`:
- Worktree: `/home/marc/escapement-worktrees/42-fix-login-flow`
- Branch: `42-fix-login-flow`

### 3.2 Create worktree

For each node:

```bash
# Ensure worktree base directory exists
mkdir -p "{project-root}/../{repo-name}-worktrees"

# Create worktree with new branch from develop
git worktree add "{worktree-path}" -b "{branch-name}" origin/develop
```

**Handle existing worktree/branch:**
- If worktree already exists at that path, report and skip creation
- If branch already exists but no worktree, create worktree using existing branch:
  ```bash
  git worktree add "{worktree-path}" "{branch-name}"
  ```

### 3.3 Verify creation

```bash
git worktree list
```

Report each created worktree:
```
Created worktrees:
  {worktree-path} [{branch-name}]
  {worktree-path} [{branch-name}]
  ...
```

---

## Phase 4: Batch Scratchpad Generation

Generate scratchpads for all dispatched items in one pass, then present a single batch approval.

### 4.1 Gather issue details

For each node, collect:
- Issue number and title (from manifest work item)
- Issue body (from GitHub via `mcp__github__get_issue` if available, or from manifest `meta`)
- Predicted files (from manifest)
- Dependencies (from manifest edges)

### 4.2 Generate scratchpads

For each node, create `SCRATCHPAD_{issue_number}.md` in the worktree root following the standard template:

```markdown
# {Issue Title} - #{issue_number}

## Issue Details
- **Repository:** {repo}
- **GitHub URL:** {issue_url}
- **Manifest ID:** {manifest_id}

## Description
{issue body}

## Acceptance Criteria
{from issue task list}

## Branch Strategy
- **Base branch:** develop
- **Feature branch:** {branch-name}

## Implementation Checklist
{Generated from issue tasks and predicted files}

## Agent Constraints
See AGENT_CONSTRAINTS.md in this worktree root for file ownership rules.

## Work Log
---
**Generated:** {timestamp}
**By:** manifest-dispatch skill
```

### 4.3 Present batch for approval

```
AskUserQuestion:
  question: "Generated {N} scratchpads. Approve all before proceeding?"
  header: "Scratchpads"
  options:
    - label: "Approve all"
      description: "All scratchpads look good, proceed with dispatch"
    - label: "Review individually"
      description: "Let me review each scratchpad before approving"
    - label: "Cancel"
      description: "Remove worktrees and abort dispatch"
```

**If "Review individually":** For each scratchpad, display a summary and ask:
```
AskUserQuestion:
  question: "Approve scratchpad for {id}: {name}?"
  header: "Review"
  options:
    - label: "Approve"
    - label: "Skip this item"
    - label: "Cancel all"
```

---

## Phase 5: Generate Agent Constraint Blocks

For each dispatched node, generate `AGENT_CONSTRAINTS.md` in the worktree root.

### 5.1 Constraint block template

Follow the V2 Section 12 template exactly:

```markdown
# Agent Constraints

You are working on: {item_id}

## Files you own
{Files from the node's `owned_files` list -- these are safe to modify freely}
- {file1}
- {file2}

## Shared files
{Files that appear in multiple nodes' predicted_files -- must follow rules}
- {shared_file}
  Rule: {rule based on assessment}

## Do not touch
{Files owned by other nodes in the same parallel group -- forbidden}
- {forbidden_file1}
- {forbidden_file2}

## Validation Policy
{Resource constraints from the dispatch plan}
- {constraint 1}
- {constraint 2}
```

### 5.2 Deriving file lists

From the dispatch plan:
- **Owned files**: Node's `predicted_files` minus any files shared with other nodes in the group
- **Shared files**: Files appearing in 2+ nodes' `predicted_files` within the group. Rules come from the plan's conflict assessments:
  - `trivial`: "modify only the relevant export/registration line"
  - `additive`: "modify only the {item_id} case/section"
  - `semantic`/`unknown`: should not appear in same group (plan would have separated them)
- **Forbidden files**: All `predicted_files` of other nodes in the same group, minus shared files

### 5.3 Write constraint files

```bash
# For each worktree
Write: {worktree-path}/AGENT_CONSTRAINTS.md
```

---

## Phase 6: Mark Items In-Progress

After worktrees, scratchpads, and constraint blocks are all in place:

```bash
# For each dispatched node
node --import tsx manifest/manifest-cli.ts in-progress "{item_id}" "{branch-name}"
```

Verify with:

```bash
node --import tsx manifest/manifest-cli.ts query "SELECT id, state, branch FROM work_items WHERE state = 'in_progress'"
```

---

## Phase 7: Launch Agent Sessions

Use the Task tool to spawn parallel agent sessions, one per dispatched node.

### 7.1 Agent session template

For each node, launch a Task:

```
Task:
  description: "Work on {item_id}: {item_name}"
  prompt: |
    You are working in worktree: {worktree-path}
    Branch: {branch-name}
    Issue: #{issue_number} -- {item_name}

    IMPORTANT: Read AGENT_CONSTRAINTS.md in the worktree root before starting.
    It defines which files you own, which are shared (with rules), and which are forbidden.

    Your task:
    1. Read AGENT_CONSTRAINTS.md and follow all file ownership rules
    2. Read SCRATCHPAD_{issue_number}.md for the implementation plan
    3. Work through all implementation tasks in the scratchpad
    4. Commit your changes on branch {branch-name}
    5. Do NOT open a PR -- the orchestrator will handle that

    Validation policy:
    {validation_constraints}

    Run: Skill: do-work, args: "{issue_number}"
  isolation: worktree
  run_in_background: true
```

### 7.2 Launch all agents

Launch all agents in a single message for maximum parallelism:

```
For N nodes, emit N Task calls simultaneously.
```

### 7.3 Track launched agents

Record agent IDs for monitoring:

```
Dispatched Agents:
  {item_id} -> agent:{agent_id} in {worktree-path}
  {item_id} -> agent:{agent_id} in {worktree-path}
  ...
```

---

## Phase 8: Validation Policy and Output Summary

### 8.1 Emit validation policy

Present the validation policy prominently:

```
Validation Policy (all agents must respect):
  - {constraint 1, e.g., "max 2 concurrent Node-heavy tasks"}
  - {constraint 2, e.g., "serialize TypeScript builds"}
  - {constraint 3, e.g., "serialize integration tests"}
```

### 8.2 Final dispatch report

```
Dispatch Complete

Items dispatched: {N}
Parallel groups: {G}
Worktrees created: {W}
Agents launched: {A}

Dispatched Items:
  {id}  {name}  {branch}  {worktree-path}
  ...

Blocked (not dispatched):
  {id}  {name}  (waiting on: {dependency_ids})
  ...

Human-gated (not dispatched):
  {id}  {name}  (reason: {needs_human reason})
  ...

Next Steps:
  - Monitor agent progress (agents are running in background)
  - When agents complete, review their commits
  - Use manifest-sync to mark completed items and recompute frontier
  - Use manifest-check to verify health after merging
```

---

## Re-Dispatch Safety

The dispatch skill is idempotent:
- Worktree creation skips if path already exists
- Branch creation handles existing branches gracefully
- `in-progress` command is a no-op if already in_progress
- Constraint blocks are overwritten (latest plan state wins)
- Scratchpads use `SCRATCHPAD_{N}.md` which can be regenerated

To re-dispatch after plan changes:
1. Run `manifest-plan` to get updated plan
2. Run `manifest-dispatch` again -- it will create new worktrees for new items and skip existing ones

---

## Error Handling

### No frontier items
```
No dispatchable items on the frontier. Nothing to dispatch.

Possible reasons:
  - All items are done or in_progress
  - Remaining items have unmet dependencies
  - Items are human-gated (needs_human = true)

Run 'manifest status' for overview.
Run 'manifest frontier' to see what's available.
```

### Worktree creation fails
```
Failed to create worktree for {item_id}:
  {git error message}

Options:
  1. Skip this item and continue with others
  2. Retry after fixing the issue
  3. Cancel dispatch
```

### Agent launch fails
```
Failed to launch agent for {item_id}:
  {error}

The worktree and branch were created successfully.
You can manually start work:
  cd {worktree-path}
  claude  # then: do-work #{issue_number}
```

---

## Integration with Other Skills

**Depends on:**
- `manifest-plan` -- provides the DispatchPlan
- `manifest-bootstrap` -- populates the manifest database

**Invokes:**
- `do-work` -- via Task tool agents in each worktree

**Followed by:**
- `manifest-sync` -- after agents complete, marks items done
- `manifest-check` -- verifies health after merging

---

**Version:** 1.0.0
**Last Updated:** 2026-03-31
**Maintained By:** Escapement
