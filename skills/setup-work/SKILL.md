---
name: setup-work
description: Setup development environment from GitHub issue. Invoke when user says "init work on issue #X", "initialize issue #X", "setup issue #X", "prepare issue #X", "start fresh on issue #X", "start new work on issue #X", or provides a GitHub issue URL.
tools:
  - mcp__serena__*
  - mcp__github__*
  - mcp__linear__*
  - Bash:git *
  - Bash:bash *
  - Bash:mktemp *
  - Bash:sha256sum *
  - Bash:test *
  - Bash:ls *
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - Task
  - LSP
---

# Issue Setup Skill

## Purpose
Transform a GitHub issue into a fully-prepared development environment with:
- Complete issue context and acceptance criteria
- Structured implementation plan (scratchpad)
- Feature branch ready for work
- Situational codebase awareness

**Factory path (optional, docs/FACTORY_DESIGN.md §3).** When the project is set up for the Escapement factory, setup-work also checks readiness, gathers light context, proposes a risk tier and drafts a validation contract, and plan approval can authorize a factory run. Steps marked **[factory]** run only on this path. When the project isn't set up for it (Phase 0.5), skip every **[factory]** step: setup-work then behaves exactly as it always has. Plain approval never creates a run.

The factory runner is `bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"`, written `factory` below (reference: `docs/FACTORY_CLI.md`). Run it from the project root. Always pass `--json` and route on the JSON, never on the text. (`manifest.sh` has no JSON mode; read its text.)

Each Bash call starts a fresh shell, so variables such as `$FACTORY`, `$MANIFEST_DB`, `$DRAFT_DIR` and `{target_ref}` don't carry over between calls. Note their literal values when you first get them, and write those values into later commands.

## Context Prerequisites

Before beginning, load critical project context:

### Project Structure
Read the project's CLAUDE.md to understand:
- Module architecture
- Development philosophy
- Current sprint priorities
- Branch naming conventions

### Codebase Orientation
Get a high-level view of the repository structure to identify affected areas.

## Workflow Execution

### Phase 0: Check Existing Context (Self-Correction)

**Before proceeding with setup, check if work already initialized:**

1. **Detect existing scratchpad** for this issue only (another issue's scratchpad doesn't count):
   ```bash
   ls SCRATCHPAD_{issue_number}.md 2>/dev/null
   ```

2. **If scratchpad exists:**
   ```
   ✓ Scratchpad already exists for this issue.

   Delegating to do-work skill...
   ```

   Then invoke:
   ```
   Skill: do-work
   args: "{issue_number}"
   ```

   **STOP here** - don't proceed with setup.

3. **If no scratchpad:**
   - Proceed to Phase 0.5

### Phase 0.5: Detect the Factory Path

```bash
FACTORY="${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"
bash "$FACTORY" --check && bash "$FACTORY" --json check
```

`check` without `--contract` checks only the project's `## Escapement Settings`.

- **`--check` fails** (runner dependencies not installed), or **`.result.status` is `needs_human`**: `FACTORY=off`. Skip every **[factory]** step. If `.result.required_checks` has at least one non-null `command` but `check` still asked questions, the project is partly set up: say so in one line of the final output (`Factory run not offered: {questions}`), so the operator knows why. Otherwise stay silent: most projects aren't set up for the factory.
- **`.result.status` is `ready`**: `FACTORY=on`. Keep `.result.required_checks` for the scratchpad, and `.result.target_ref`, the branch the run will target, as `{target_ref}` (Phase 4).

Decide availability only from `check`, never by reading CLAUDE.md yourself: `check` applies the section and fence rules.

### Phase 1: Gather Context (Parallel)

**Input:** Issue reference in format `owner/repo#number` or just `#number` (uses current repo)

**Examples:**
- `owner/repository#42`
- `#42` (assumes current repository)

**Execute these operations in parallel** for faster setup:

1. **Repository Context:**
   - Determine owner/repo from input or git remote
   - Read project's `CLAUDE.md` for conventions
   - Check current git status and branch

2. **Issue Details:**
   - Retrieve complete issue using GitHub tools:
     - Title, body (description), labels
     - State (open/closed), assignees
     - Milestone, project associations
     - All comments (especially implementation details)
     - Linked issues (mentions, closes, related)

3. **Generate branch name** (after issue fetched):
   - Format: `{issue-number}-{slugified-title}`
   - Example: `42-implement-fact-batching`
   - Sanitize title: lowercase, spaces→hyphens, remove special chars

4. **Build issue context map:**
   - Is this part of a milestone/project?
   - Are there dependent issues (blocks/blocked-by)?
   - What's the priority based on labels?
   - Are there linked PRs already?

5. **[factory] Light context (§3.2):**
   - `CONTEXT_PATH=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/get-context-path.sh" CLAUDE.md)`. The lore file is `{context-path}/PROJECT_LORE.md`, or `PROJECT_LORE.md` in the project root when context-path is empty.
   - **Lore:** pick the entries that bear on the areas this issue touches. Quote them verbatim; don't paraphrase.
   - **Related archives:** in `{context-path}/INDEX.md`, find the issues this one depends on or relates to. Each row names a branch; its archive is `{context-path}/{branch}/archive/README.md` (a manifest work item's `archive_path` points there too). Read its Key Decisions and Lessons Learned. This needs the issue's dependencies, so do it after the issue is fetched.
   - **Manifest work item**, if there is one. Opening the manifest creates it, so first check that it exists, and skip the manifest entirely (here and in Phase 3.5) when it doesn't:
     ```bash
     MANIFEST_DB=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" db-path)   # never opens or creates it
     test -f "$MANIFEST_DB"
     ```
     Only the `owner/repo` from the git remote and the numeric issue number go into the SQL:
     ```bash
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" query "SELECT id, archive_path FROM work_items WHERE repo = '{owner/repo}' AND issue_number = {number}"
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" query "SELECT d.id, d.state, d.archive_path FROM edges e JOIN work_items d ON d.id = e.to_id WHERE e.rel = 'depends_on' AND e.from_id = '{id}'"
     ```
     Keep the work item's `id` as `{manifest_id}` (none when there's no row). Read the archives of its dependencies too. A dependency that isn't `done` is a readiness question (Phase 2).

### Phase 2: Analyze & Plan

**Goal:** Understand the issue deeply before writing any code.

**Analysis Steps:**

0. **[factory] Readiness check (§3.1), before planning:**
   - Are acceptance criteria present, or derivable from the description?
   - Is anything about intent, scope or dependencies unresolved, such as a dependency that isn't done?
   - Could each criterion be given evidence: a test, a command, or a manual check a human can carry out? A criterion that can't is a readiness failure.

   Write each problem as a readiness question, `{"about": "intent" | "scope" | "dependency" | "criterion", "question": "…", "ref": "AC-2"}` (`schemas/factory/readiness.schema.json`). If a question would change the plan, ask it now with `AskUserQuestion`, as in Phase 3.5, and record the answer under Decisions Made before planning. The rest go to Clarifications Needed.

1. **Requirements Review:**
   - Parse issue body for requirements/acceptance criteria
   - Check for task lists (- [ ] items) in issue body
   - Identify ambiguities or missing information
   - Note any conflicting requirements in comments

2. **Codebase Investigation (Delegate to Scratchpad-Planner Agent):**

   For thorough codebase analysis, use the **scratchpad-planner agent** (an agent, not a skill):

   ```
   Agent:
     subagent_type: escapement:scratchpad-planner
     prompt: "issue #{number}: {issue title}

          Summary: {brief issue summary}

          Key requirements:
          {extract key requirements from issue body}

          Affected areas (if known):
          {mention specific modules/components if issue indicates}

          Repository: {owner/repo}
          Project context: See CLAUDE.md for module structure and conventions

          [factory only] Validation contract: also propose the risk tier
          with reasons, the predicted files, and evidence for every
          acceptance criterion (see the agent's Validation Contract
          section). Lore entries: {quoted entries}. Related archives:
          {decisions and lessons}. Decisions so far: {answers}."
   ```

   The scratchpad-planner agent will:
   - Read project's CLAUDE.md for conventions and structure
   - Search for relevant existing code patterns using Grep and LSP
   - Identify affected modules/components and integration points
   - Find similar implementations to learn from
   - Generate atomic task breakdown following project conventions
   - Ask clarifying questions for ambiguous requirements
   - Support resumable analysis for complex codebases

   The agent replaces generic exploration with specialized planning expertise,
   providing more structured analysis and implementation approach generation.

3. **Technical Breakdown:**
   - Break work into atomic, committable tasks
   - Identify integration points
   - Flag potential challenges
   - Estimate complexity/scope

4. **Dependency Check:**
   - Does this require other issues first? (check "depends on" mentions)
   - Will this block other work? (check "blocks" mentions)
   - Are there API contract implications?
   - Check milestone dependencies

### Phase 3: Create Scratchpad

**Generate:** `SCRATCHPAD_{issue_number}.md`

**Template Structure:**

````markdown
# {Issue Title} - #{issue_number}

## Issue Details
- **Repository:** {owner/repo}
- **GitHub URL:** {issue_url}
- **State:** {open/closed}
- **Labels:** {labels}
- **Milestone:** {milestone if exists}
- **Assignees:** {assignees}
- **Related Issues:** {linked issues if any}
  - Depends on: #{issue_numbers}
  - Blocks: #{issue_numbers}
  - Related: #{issue_numbers}

## Description
{full issue body from GitHub}

## Acceptance Criteria
{extract task list from issue body, or create from description}
- [ ] {criterion 1}
- [ ] {criterion 2}
- [ ] {criterion 3}

## Readiness
{[factory] only; leave the section out when FACTORY=off}
- **Status:** {ready | needs_human}
- **Proposed tier:** {standard | sensitive}: {reasons}
- **Required checks:** {name: command, from factory check}
- **Open questions:** {each readiness question, or "none"}
- **Context:** {lore entries quoted verbatim; related archives and what they decided}

## Validation Contract
{[factory] only. Approved together with the plan; run_id is filled in when the run starts.}

| Criterion | Evidence | Type | Kind | Demonstrated by |
|---|---|---|---|---|
| AC-1 {criterion text} | AC-1.e1 | test | new_behavior | `tests/auth/refresh.test.ts::rejects expired token` |

```json
{
  "version": 1,
  "run_id": "pending",
  "issue": {issue_number},
  "manifest_id": {"{manifest_id}" or null},
  "risk_tier_proposed": "standard",
  "risk_reasons": [],
  "criteria": [
    {
      "id": "AC-1",
      "text": "{criterion text}",
      "evidence": [
        { "id": "AC-1.e1", "type": "test", "kind": "new_behavior", "selector": "tests/auth/refresh.test.ts::rejects expired token" }
      ]
    }
  ],
  "predicted_files": ["src/auth/refresh.ts", "tests/auth/refresh.test.ts"]
}
```

## Branch Strategy
- **Base branch:** main (or develop-ts/develop if exists)
- **Feature branch:** {issue_number}-{slugified-title}
- **Current branch:** {git branch --show-current}

## Implementation Checklist

### Setup
- [ ] Fetch latest from base branch
- [ ] Create and checkout feature branch

### Implementation Tasks
{Break down into atomic commits - each should be independently reviewable}

- [ ] {First atomic task with clear scope}
  - Files affected: {list}
  - Why: {brief rationale}
  
- [ ] {Second atomic task}
  - Files affected: {list}
  - Why: {brief rationale}

{Continue with granular breakdown...}

### Quality Checks
- [ ] Run linter/type checker
- [ ] Execute relevant tests
- [ ] Self-review for code quality
- [ ] Verify acceptance criteria met

### Documentation
- [ ] Update relevant README/docs (if applicable)
- [ ] Add inline comments for complex logic (if applicable)

## Technical Notes

### Architecture Considerations
{Any architectural decisions to consider}
{Module boundaries to respect}
{Integration points to handle}

### Implementation Approach
{High-level strategy for solving the problem}
{Why this approach vs alternatives}

### Potential Challenges
{Known complexity areas}
{Technical debt to navigate}
{Performance considerations}

## Questions/Blockers

### Clarifications Needed
{List any unclear requirements}
{Ambiguities in issue description}

### Blocked By
{List any dependencies not yet complete - reference issue numbers}

### Assumptions Made
{Document assumptions if requirements unclear}

### Decisions Made
{Populated during Phase 3.5 Interactive Q&A}
{Format: Q: question → A: decision (rationale)}

## Work Log

{This section fills in during execution via do-work}
{Each work session adds dated entries}

---
**Generated:** {timestamp}
**By:** Issue Setup Skill
**Source:** {github_issue_url}
````

**Scratchpad Quality Guidelines:**

- **Atomic tasks:** Each checklist item should be one commit
- **Clear scope:** Reader should understand what each task does
- **Testable:** Acceptance criteria should be verifiable
- **Realistic:** Don't over-engineer or under-scope
- **Contextual:** Reference project-specific conventions

### Phase 3.2: Check the Contract [factory]

The contract (`schemas/factory/contract.schema.json`, design §5) says what the work must demonstrate, never how the project's checks run:
- One criterion per acceptance criterion, IDs `AC-1`, `AC-2`, …; evidence IDs `AC-1.e1`, `AC-1.e2`, ….
- **Evidence types:** `test` (`selector`: `path::test name`, or a bare path for every test in the file, read from the structured results of the project's `verify`), `command` (`run` plus `expect.exit_code`, optionally `stdout_matches` / `stdout_not_matches`), or `manual` (`instructions` a human can follow and check).
- **Kind:** `new_behavior` when the evidence should fail without this change (the plan says so); `regression` when it is expected to pass already.
- **Tier:** `sensitive` when the work touches the project's `sensitive-paths`, changes execution policy (test or lint config, CI, scripts, `validation-files`), or by judgment: migrations, auth, money, public API, architecture. Otherwise `standard`. In `risk_reasons`, give only judgment reasons (such as "changes which tokens are accepted"): `check` adds a reason for every predicted file matching `sensitive-paths` or `validation-files` itself.
- Never add `setup`, `static` or `verify` commands: those come only from settings.

Check the draft from outside the tree:

```bash
DRAFT_DIR=$(mktemp -d)
# write the scratchpad's contract JSON block to "$DRAFT_DIR/contract.json"
bash "$FACTORY" --json check --contract "$DRAFT_DIR/contract.json"
```

- `.result` is a readiness document. Add your own readiness questions from Phase 2 to its `questions` (same shape), and make `status` `needs_human` if there are any.
- Fill the scratchpad's `## Readiness`: status, the tier and reasons from `.result.tier` (the runner never lowers a proposed tier), required checks, and the open questions.
- Each open question also goes to Clarifications Needed, for Phase 3.5.

### Phase 3.5: Interactive Q&A (Resolve Clarifications)

**Goal:** Resolve any questions or ambiguities before starting implementation.

**Trigger:** If the scratchpad has items in the "Clarifications Needed" section.

**Process:**

1. **Check for Outstanding Questions:**
   - Review the Questions/Blockers section of the scratchpad
   - If "Clarifications Needed" is empty, skip to Phase 4
   - If questions exist, proceed with interactive resolution

2. **Present Questions via AskUserQuestion:**
   For each clarification needed, use the `AskUserQuestion` tool to get user input:

   ```
   AskUserQuestion:
     question: "{The specific clarification question}"
     header: "Clarify"
     options:
       - label: "{Option A}"
         description: "{What this choice means}"
       - label: "{Option B}"
         description: "{What this choice means}"
       - label: "{Option C}" (if applicable)
         description: "{What this choice means}"
     multiSelect: false (or true if multiple answers valid)
   ```

   **Guidelines for presenting questions:**
   - Frame questions clearly with context
   - Provide 2-4 concrete options when possible
   - Include descriptions explaining implications of each choice
   - User can always select "Other" for custom input
   - Group related questions if they have dependencies

3. **Update Scratchpad with Decisions:**
   After collecting all answers, update the scratchpad:

   a) **Add "Decisions Made" section** (if not present) under Questions/Blockers:
   ```markdown
   ### Decisions Made
   {Timestamp}

   **Q: {Original question}**
   **A:** {User's answer/decision}
   **Rationale:** {Brief explanation of why, if provided}
   ```

   b) **Remove resolved items** from "Clarifications Needed"

   c) **Update relevant sections** if decisions affect:
      - Implementation tasks (add/remove/modify based on decisions)
      - Technical approach
      - Assumptions (convert to confirmed decisions)
      - **[factory]** The Validation Contract: criteria, evidence, tier, predicted files

   d) **[factory] Re-check and mirror readiness.** If the answers changed the contract, rewrite `$DRAFT_DIR/contract.json` from the scratchpad and run Phase 3.2's `check` again, until it is `ready` or the operator leaves questions open. Then, changed or not, mirror the final readiness into the manifest, whatever the status, so a stale `needs_human` is cleared too:
      ```bash
      # $DRAFT_DIR/readiness.json: {"version": 1, "status": …, "questions": […]}
      bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" readiness {owner/repo} {issue_number} "$DRAFT_DIR/readiness.json"
      ```
      Only when `$MANIFEST_DB` exists (Phase 1). It does nothing when the issue has no work item. Update `## Readiness` with the final status.

4. **Confirm Resolution:**
   Display summary of decisions made:
   ```
   ✓ Resolved {N} clarifications:

   1. {Question summary} → {Decision}
   2. {Question summary} → {Decision}
   ...

   📋 SCRATCHPAD updated with decisions.
   ```

**Example Interaction:**

```
📋 SCRATCHPAD_42.md has 3 clarifications that need resolution before proceeding.

[AskUserQuestion 1/3]
Question: "Should we keep commands as aliases during the transition to skills?"
Header: "Migration"
Options:
  - "Keep as thin wrappers" - Commands remain but delegate to skills
  - "Remove immediately" - Clean break, skills only
  - "Decide per-command" - Evaluate each command individually

[User selects: "Keep as thin wrappers"]

[AskUserQuestion 2/3]
Question: "How should prime-session be handled?"
Header: "Behavior"
Options:
  - "Convert to auto-invoke skill" - Activates when entering new repo
  - "Keep as explicit command" - User must invoke manually
  - "Remove entirely" - Claude reads CLAUDE.md automatically anyway

[User selects: "Keep as explicit command"]

...

✓ Resolved 3 clarifications:

1. Migration strategy → Keep commands as thin wrappers
2. prime-session behavior → Keep as explicit command
3. ...

📋 SCRATCHPAD_42.md updated with decisions.
Proceeding to branch creation...
```

**Skip Conditions:**
- No items in "Clarifications Needed" → Skip directly to Phase 3.6 (**[factory]** after step 3d: mirror the readiness)
- User explicitly requests to skip → Note unresolved questions, proceed with assumptions. **[factory]** Readiness stays `needs_human`; mirror it (step 3d)

### Phase 3.6: Plan Approval

**Goal:** Get explicit user approval of the implementation plan before preparing the workspace.

This mirrors Claude's EnterPlanMode/ExitPlanMode approval pattern — the user reviews and signs off on the plan before any workspace changes.

1. **Present Plan Summary:**
   ```
   📋 SCRATCHPAD_{issue_number}.md ready for review:

      {X} implementation tasks
      {Y} quality checks
      {Z} decisions resolved
      [factory] readiness: {ready | needs_human}, proposed tier: {tier}
      [factory] contract: {N} criteria, {M} evidence ({t} test, {c} command, {m} manual)

   Key changes:
   - {Brief summary of major tasks}
   ```

2. **Request Approval:**
   ```
   AskUserQuestion:
     question: "Approve this implementation plan?"
     header: "Plan"
     options:
       - label: "Approve + authorize run"   # [factory] only, and only when readiness is ready
         description: "Approve the plan and its validation contract: check out the branch, start a factory run and authorize it"
       - label: "Approve"
         description: "Plan looks good, create branch and proceed"
       - label: "Revise plan"
         description: "Re-run planning with adjusted focus"
       - label: "Let me review"
         description: "I'll read the scratchpad first, then decide"
   ```

   Offer **Approve + authorize run** only when `FACTORY=on` and the final readiness is `ready`. A `needs_human` plan can still get plain **Approve**.

3. **Handle Response:**
   - **Approve + authorize run:** Note the choice in the Work Log, then proceed to Phase 4 and Phase 4.5
   - **Approve:** Proceed to Phase 4 only. No run is created, and the Validation Contract stays a draft in the scratchpad
   - **Revise plan:** Resume scratchpad-planner agent with user feedback, then return to Phase 3.6
   - **Let me review:** Wait for user to read SCRATCHPAD, then re-ask approval

**This phase is NOT skippable.** The user must explicitly approve before workspace preparation begins.

### Phase 4: Prepare Workspace

**Branch Creation:**

1. **Detect base branch:**
   ```bash
   # Check what branches exist
   git fetch origin
   
   # Prefer in this order:
   # 1. develop-ts (if exists)
   # 2. develop (if exists)
   # 3. main (default)
   git branch -r | grep -E 'origin/(develop-ts|develop|main)'
   ```

   **[factory]** On the factory path, don't detect: the base branch is `{target_ref}` from Phase 0.5, the branch the run will target (the project's `base-branch` setting, else `develop` when `origin/develop` exists, else `main`). Branch and run then agree.

2. **Create feature branch:**
   ```bash
   # Generate branch name from issue
   # Format: {issue_number}-{slugified-title}
   # Example: 42-implement-fact-batching
   
   git branch {issue-number}-{slugified-title} origin/{base-branch}
   # Don't checkout yet - let operator decide when to switch
   ```
   **[factory]** Add `--no-track`, so the branch doesn't track `origin/{base-branch}`: the run is authorized to push its branch, and a branch tracking the base could push to it. Use the local `{base-branch}` if `origin/{base-branch}` doesn't exist.

3. **Confirm creation:**
   ```bash
   git branch --list {branch-name}
   ```

### Phase 4.5: Authorize the Run [factory]

Only after **Approve + authorize run**. The approved plan and contract become a run and its authorization (§3.6). Stop at the first step that fails, report it, and leave the rest: nothing here is retried silently.

1. **Check out the branch.** A run is bound to the worktree and branch it starts on.
   ```bash
   git status --porcelain --untracked-files=no   # must print nothing
   git checkout {branch-name}
   ```
   Tracked changes: stop and ask the operator to commit or stash them. Don't authorize a run on top of them.

2. **Exclude the working files.** Validation needs a clean tree, and these files never belong in it:
   ```bash
   bash "$FACTORY" --json exclude 'SCRATCHPAD_*' 'SESSION_LOG_*' AGENT_CONSTRAINTS.md
   ```

3. **Start the run:**
   ```bash
   bash "$FACTORY" --json start '{owner/repo}#{issue_number}' --target-ref {target_ref} [--manifest-id {manifest_id}]
   ```
   Name the work item with its repository: run IDs share one per-user database across projects, and `owner/repo#42` gives `owner-repo#42-r1`. Keep `.result.run_id` and `.result.artifact_dir`, and single-quote the run ID in every later command (it contains `#`). On `run_exists`, this worktree already has an open run: show `factory status` and stop.

4. **Write the contract into the run.** Set `run_id` to the new run ID in the scratchpad's contract block, and write the same JSON to `{artifact_dir}/contract.draft.json`. Change nothing else: what the operator approved is what gets authorized.

5. **Check it:**
   ```bash
   bash "$FACTORY" --json check --contract "{artifact_dir}/contract.draft.json"
   ```
   It must be `ready`. If it isn't, stop: show the questions. The run stays `planned` with no authorization, and setup-work leaves it there for the operator.

6. **Approve it:**
   ```bash
   bash "$FACTORY" --json approve '{run_id}' --contract "{artifact_dir}/contract.draft.json"
   ```
   The runner stores the bytes as `{artifact_dir}/contract.json`, records their digest and issues an `active` authorization. The run moves to `approved`, and the run deadline starts.

7. **Confirm the digest.** The authorization must name exactly the contract that was approved:
   ```bash
   echo "sha256:$(sha256sum "{artifact_dir}/contract.json" | cut -d' ' -f1)"
   bash "$FACTORY" --json status '{run_id}'   # .result.authorization: status "active", contract_digest
   ```
   The two digests and approve's `.result.authorization.contract_digest` must be equal. If they aren't, run `factory revoke '{run_id}'` and stop.

8. **Record the run** in the scratchpad. Tick both Setup items in its Implementation Checklist (the branch is fetched, created and checked out), and add this after `## Validation Contract`:
   ```markdown
   ## Factory Run
   - **Run:** {run_id} (approved {approved_at})
   - **Artifacts:** {artifact_dir}
   - **Contract digest:** {contract_digest}
   - **Deadline:** {deadline_at}
   - **Authorizes:** {authorizes}; never merge, force-push or a contract change
   ```

Any later change to the contract needs `factory approve` again, which supersedes this authorization.

**Final Output:**

Display concise summary:
```
✓ Issue #{issue_number} analyzed and prepared

📋 SCRATCHPAD_{issue_number}.md created with:
   - {X} implementation tasks
   - {Y} quality checks
   - {Z} decisions made (via Q&A)

🌿 Branch '{issue-number}-{slugified-title}' created from {base-branch}

🔗 GitHub Issue: {issue_url}

🚀 Ready to begin work:
   git checkout {branch-name}
   # Then start implementation
```

After **Approve + authorize run**, the branch is already checked out. Replace the last block with:
```
🏭 Factory run {run_id} authorized (state: approved)
   Contract: {artifact_dir}/contract.json ({contract_digest})
   Deadline: {deadline_at}

🚀 Ready to begin work on {branch-name}
```

**Note:** If clarifications were resolved in Phase 3.5, the scratchpad now contains
confirmed decisions rather than open questions. All ambiguities should be resolved
before reaching this point.

## Project-Specific Adaptations

### For UI/Frontend Projects:

**Component Context:**
- Which components affected?
- State management implications?
- API contract dependencies?

### For API/Backend Projects:

**Contract Context:**
- API endpoints added/modified?
- Breaking changes?
- Database migrations needed?

## Error Handling

### Issue Not Found
If GitHub issue doesn't exist:
- Verify issue number and repository
- Check if issue is in different repo
- Offer to search issues by title/keyword
- Confirm you have access to private repos (if applicable)

### Insufficient Information
If issue lacks description or clear scope:
- Note this prominently in Questions/Blockers
- Suggest adding task list to issue before starting work
- Don't guess - make assumptions explicit
- Consider commenting on issue to request clarification

### Branch Already Exists
If feature branch already exists:
- Check if work in progress (git log)
- Offer to resume vs. create new branch
- Warn about potential conflicts
- Suggest reviewing existing commits

### Factory Run Not Authorized
If a Phase 4.5 step fails, report the step, the runner's error code and message, and the state it left:
- before `start`: no run exists;
- after `start`: run `{run_id}` is `planned` without authorization. Fix the cause and run `factory approve` with the contract, or leave it;
- after `approve` with a digest mismatch: the authorization has been revoked.

The branch, scratchpad and excludes stay as they are. Plain setup-work is unaffected.

### Repository Access Issues
If can't access repository:
- Verify GitHub authentication (gh auth status)
- Check repository exists (might be private)
- Confirm repository name spelling
- Ensure gh CLI is installed and configured

## Integration with Other Skills

**Flows to:**
- `do-work` - Begin execution from scratchpad
- `commit-changes` - Make atomic commits as checklist progresses

**Receives context from:**
- Project CLAUDE.md - Architecture and conventions
- `/prime-session` - Current development priorities
- **[factory]** `PROJECT_LORE.md`, archives in `{context-path}/INDEX.md`, the manifest work item

**Calls [factory]:**
- `scripts/factory.sh`: `check`, `exclude`, `start`, `approve`, `status` (`docs/FACTORY_CLI.md`)
- `scripts/manifest.sh readiness`: mirrors `needs_human` into the work item

## Best Practices

### ✅ DO:
- Read acceptance criteria carefully
- Break work into truly atomic commits
- Flag ambiguities early
- Research codebase before planning
- Make scratchpad detailed but scannable
- Document assumptions explicitly

### ❌ DON'T:
- Start coding before scratchpad approved
- Skip Phase 3.6 plan approval — user must sign off before branch creation
- Guess at unclear requirements
- Create tasks too large to review
- Skip codebase investigation
- Over-engineer the plan
- Hide complexity in vague task descriptions

## Operator Interaction Points

**Before Scratchpad Creation:**
If issue is complex or ambiguous, ask:
- "This issue affects multiple modules. Should we break it into sub-issues?"
- "Acceptance criteria unclear on X. Should we clarify before planning?"

**After Scratchpad Created (Phase 3.6):**
Explicit approval required — handled by Phase 3.6 Plan Approval step.
User must approve, request revision, or review before branch creation proceeds.

**Before Branch Creation:**
Plan approval (Phase 3.6) already covers creating the branch, and on the factory path checking it out and authorizing the run; don't ask again. Ask only about something approval didn't cover, such as:
- "Base branch develop-ts is 5 commits behind origin. Pull first?"

## Success Criteria

A successful issue setup produces:

✓ **Complete context:** All issue details captured
✓ **Clear plan:** Implementation steps are atomic and logical
✓ **Identified risks:** Challenges flagged upfront
✓ **Ready workspace:** Branch created, scratchpad prepared
✓ **Operator confidence:** Developer knows exactly what to build

The scratchpad should be so clear that another developer could pick it up and execute it.

### Complex Implementation Detection

If the issue analysis reveals a complex implementation, suggest entering plan mode:

**Triggers for EnterPlanMode:**
- Implementation affects more than 3-4 files
- Multiple valid architectural approaches exist
- Significant refactoring required
- New patterns or abstractions needed
- Breaking changes to existing APIs

**Suggestion:**
```
This issue appears complex ({reason}). Would you like me to enter
plan mode to design the implementation approach before we proceed?
```

---

**Version:** 1.2.0
**Last Updated:** 2026-11-16
**Maintained By:** Escapement
**Changelog:**
- v1.2.0: Factory path (docs/FACTORY_DESIGN.md §3): readiness, light context, proposed tier and validation contract when the project is set up for the factory; "Approve + authorize run" starts and approves a factory run. Unchanged otherwise (#63)
- v1.1.0: Added Task delegation to Explore agent, parallel execution, LSP integration, EnterPlanMode triggers
