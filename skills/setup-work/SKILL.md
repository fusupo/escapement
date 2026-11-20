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

**Factory path (optional, docs/FACTORY_DESIGN.md §3).** When the project is set up for the Escapement factory, setup-work also checks readiness, gathers light context, proposes a risk tier and drafts a validation contract, has a fresh-context critic check the plan once before approval, and plan approval can authorize a factory run. Steps marked **[factory]** run only on this path. When the project isn't set up for it (Phase 0.5), skip every **[factory]** step: setup-work then behaves exactly as it always has. Plain approval never creates a run.

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
- **`.result.status` is `ready`**: `FACTORY=on`. Keep `.result.required_checks` for the scratchpad, `.result.target_ref`, the branch the run will target, as `{target_ref}` (Phase 4), and `.result.browser_tests`, the project's browser test tool or null, as `{browser_tests}` (Phase 2 and Phase 3.2).

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
   - Retrieve complete issue with the GitHub MCP tools (they act as the agent account): `mcp__github__issue_read` (`get`, `get_comments`, `get_sub_issues`):
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
   - `CONTEXT_PATH=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/get-context-path.sh" --absolute)`. It prints an absolute path resolved from the main checkout, the same from any worktree (#88). The lore file is `{context-path}/PROJECT_LORE.md`, or `PROJECT_LORE.md` in the project root when context-path is empty.
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
          {decisions and lessons}. Decisions so far: {answers}.
          Browser tests: {browser_tests} (null: the project has none)."
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

## Plan Critique
{[factory] only. Filled by Phase 3.55; one round, before approval.}
- **Verdict:** {approve | revise | escalate}: {critic's summary}
- **Tier raise:** {none | sensitive: reason (applied)}

| Finding | Severity | Checklist | Ref | Critic | Disposition |
|---|---|---|---|---|---|
| F-1 | blocking | clause_coverage | AC-2 | {detail} | accepted (planner): {plan change} |
| F-2 | major | manual_procedure_adequacy | AC-3.e1 | {detail} | rejected (operator, unresolved): {reason} |

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
- **Browser tests:** when `{browser_tests}` names a tool (`playwright`), UI behavior a browser test could drive and check (clicking, typing, what the page shows, files the app writes) is `test` evidence: a spec the plan adds, selected as `path::test title` with the path from the repository root (docs/FACTORY_CLI.md, Browser tests as evidence). Never `manual` for what a browser test could check; `manual` stays for what a machine can't judge, such as a subjective visual or reading prose. The plan critic checks this (`manual_could_be_browser_test`).
- **Kind:** `new_behavior` when the evidence should fail without this change (the plan says so); `regression` when it is expected to pass already.
- **Tier:** `sensitive` when the work touches the project's `sensitive-paths`, changes execution policy (test or lint config, CI, scripts, `validation-files`), or by judgment: migrations, auth, money, public API, architecture. Otherwise `standard`. In `risk_reasons`, give only judgment reasons (such as "changes which tokens are accepted"): `check` adds a reason for every predicted file matching `sensitive-paths` or `validation-files` itself.
- Never add `setup`, `static` or `verify` commands: those come only from settings.

Check the draft from outside the tree:

```bash
DRAFT_DIR=$(mktemp -d)
# write the scratchpad's contract JSON block to "$DRAFT_DIR/contract.json"
bash "$FACTORY" --json check --contract "$DRAFT_DIR/contract.json"
```

- `.result` is a readiness document. Write check's full `.result` to `$DRAFT_DIR/readiness.json`, add your own still-open readiness questions from Phase 2 to its `questions` (same shape), and make `status` `needs_human` if there are any. This file is the only readiness document: the manifest mirror (Phase 3.5 step 3d) and the plan critic's brief (Phase 3.55) both use it. Keep every key check returned (`tier`, `required_checks`, `target_ref`, `browser_tests`). Each later run of `check` rewrites it the same way, with only the questions still open.
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

   d) **[factory] Re-check and mirror readiness.** If the answers changed the contract, rewrite `$DRAFT_DIR/contract.json` from the scratchpad and run Phase 3.2's `check` again, until it is `ready` or the operator leaves questions open; each run rewrites `$DRAFT_DIR/readiness.json` as in Phase 3.2. Then, re-checked or not, bring `$DRAFT_DIR/readiness.json` up to date in place: drop the questions the operator answered, keep only those still open, set `status` to `ready` when none remain and `needs_human` otherwise, and keep every other key check returned. Mirror that same file into the manifest, never a cut-down copy, whatever the status, so a stale `needs_human` is cleared too:
      ```bash
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
- No items in "Clarifications Needed" → Skip directly to Phase 3.6 (**[factory]** after step 3d: mirror the readiness, then Phase 3.55)
- User explicitly requests to skip → Note unresolved questions, proceed with assumptions. **[factory]** Readiness stays `needs_human`; mirror it (step 3d)

### Phase 3.55: Plan Critique [factory]

**Goal:** One round of fresh-context critique of the plan and its contract before the operator sees them (docs/FACTORY_DESIGN.md §3.5). The critic catches what `factory check` can't: a criterion clause no evidence covers, a manual procedure that wouldn't prove its criterion, a plan step built on a wrong claim about the code.

Run it on the factory path once Phase 3.5 is done and the contract passes Phase 3.2's check with no question about the contract's own shape. If the contract itself is invalid there is nothing to critique yet: say so in the plan summary and skip to Phase 3.6.

1. **Write the brief.** In `$DRAFT_DIR` (Phase 3.2), write the issue as fetched in Phase 1 (title, body, comments) to `issue.md`, the light context from Phase 1 (lore entries quoted verbatim, related archives' decisions and lessons, manifest dependencies) to `context.md` (or leave `context` null when there is none), and the contract to `contract.json`. `readiness.json` is already there: it is Phase 3.2's file, check's full result with `tier`, `required_checks` and `browser_tests`, as step 3d left it, and the brief names it as is, never a cut-down copy. Then `brief.json`, with absolute paths (the `{plugin root}` is the directory holding `scripts/factory.sh`):
   ```json
   {
     "version": 1,
     "critic_prompt": "{path printed by: factory prompt critic}",
     "issue": { "path": "{DRAFT_DIR}/issue.md" },
     "scratchpad": { "path": "{project root}/SCRATCHPAD_{issue_number}.md" },
     "contract": { "path": "{DRAFT_DIR}/contract.json", "schema": "{path printed by: factory schema contract}" },
     "readiness": { "path": "{DRAFT_DIR}/readiness.json" },
     "context": { "path": "{DRAFT_DIR}/context.md" },
     "repo": { "path": "{project root}" },
     "critique": {
       "schema": "{path printed by: factory schema critique}",
       "write_to": "{DRAFT_DIR}/critique.json",
       "check": "bash '{plugin root}/scripts/factory.sh' --json check-critique '{DRAFT_DIR}/critique.json'"
     }
   }
   ```

2. **Run the critic,** a new agent with fresh context, given only the brief:
   ```
   Agent:
     subagent_type: escapement:plan-critic
     prompt: "Critique the plan in {DRAFT_DIR}/brief.json."
   ```
   Never resume the scratchpad-planner for this, and never pass the planner's transcript or your own account of its reasoning: the critic reads the plan the way the implementer and the reviewer will.

3. **Check the critique:**
   ```bash
   bash "$FACTORY" --json check-critique "{DRAFT_DIR}/critique.json"
   ```
   On `bad_critique`, send the critic its `.error.message` once (SendMessage to the same agent) and check again. If it is still invalid, go on without a critique and say so in the plan summary.

4. **Apply a tier raise** (`tier_raise`): set the contract's `risk_tier_proposed` to `sensitive` and add the critic's reason to `risk_reasons`. A raise is never a question; the critic can only raise a tier.

5. **One round with the planner.** When the critique has findings, whatever its verdict, resume the scratchpad-planner agent **once** with the critique and the brief's paths. For each finding it either accepts it and changes the plan or contract (say what changed), or rejects it with a reason. Apply its changes to the scratchpad and the contract, and run Phase 3.2's `check` again, which rewrites `readiness.json`; bring it up to date in place as in step 3d. Then mirror that same file into the manifest again, as step 3d does, so the manifest never keeps the status from before the planner's round:
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" readiness {owner/repo} {issue_number} "$DRAFT_DIR/readiness.json"
   ```
   Only when `$MANIFEST_DB` exists (Phase 1). It does nothing when the issue has no work item. The revised plan isn't critiqued again: the round ends here, and so does a later **Revise plan** at Phase 3.6.

   Record each answer as a disposition, `decided_by: planner`: `{"finding": "F-1", "accepted": true, "plan_change": "…"}` or `{"finding": "F-2", "accepted": false, "reason": "…"}`.

6. **What goes to the operator.** A `blocking` or `major` finding the planner rejected is **unresolved**: the critic and the planner disagree, so the operator decides, seeing both positions in the plan summary (Phase 3.6). So is every finding of an `escalate` verdict the planner didn't accept. A rejected `minor` finding stays the planner's decision, with its reason in the scratchpad.

7. **Record it in the scratchpad**, in `## Plan Critique`: the verdict and summary, the tier raise, and one row per finding with its disposition. Unresolved findings read "open: the operator decides at approval" until Phase 3.6.

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
      [factory] plan critique: {verdict}, {F} findings ({a} accepted, {r} rejected){, tier raised to sensitive}

   Key changes:
   - {Brief summary of major tasks}

   [factory] Unresolved critique findings (approving keeps the plan as it is; Revise plan takes the critic's side):
   - F-1 [blocking, clause_coverage, AC-2]
     Critic: {detail} {suggestion}
     Planner: {the planner's reason for rejecting it}
   ```

   On the factory path, always show the critique line. List every unresolved finding with both positions, `Critic:` and `Planner:`, or write "Plan critique: nothing unresolved". Never ask the approval question before the operator has seen them.

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
   - **Revise plan:** Resume scratchpad-planner agent with user feedback, then return to Phase 3.6. The revision isn't critiqued again (one round)

   **[factory] The operator's decision closes the critique.** Each unresolved finding gets a disposition `decided_by: operator`, `unresolved: true`: on either Approve, rejected, with the planner's reason; on **Revise plan**, accepted with the plan change the revision made, or rejected with the operator's reason. Update `## Plan Critique`, add `dispositions` to `{DRAFT_DIR}/critique.json`, and check the final record:
   ```bash
   bash "$FACTORY" --json check-critique "{DRAFT_DIR}/critique.json" --final
   ```
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

   **Record the critique** on the new run, when Phase 3.55 produced one:
   ```bash
   bash "$FACTORY" --json record-critique '{run_id}' "{DRAFT_DIR}/critique.json"
   ```
   It writes `{artifact_dir}/critique.json` and one `critique_finding` event per finding, with its disposition (§7.2). On `bad_critique`, fix the dispositions it names and run it again; a failure here is reported, not a reason to stop the authorization. Plain **Approve** creates no run, so its critique lives only in the scratchpad.

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
- Verify the GitHub MCP server is connected: `mcp__github__get_me` names the account it acts as (the agent)
- Check repository exists (might be private)
- Confirm repository name spelling
- Confirm that account can read the repository

## Integration with Other Skills

**Flows to:**
- `do-work` - Begin execution from scratchpad
- `commit-changes` - Make atomic commits as checklist progresses

**Receives context from:**
- Project CLAUDE.md - Architecture and conventions
- `/prime-session` - Current development priorities
- **[factory]** `PROJECT_LORE.md`, archives in `{context-path}/INDEX.md`, the manifest work item

**Calls [factory]:**
- `scripts/factory.sh`: `check`, `check-critique`, `prompt critic`, `schema`, `exclude`, `start`, `record-critique`, `approve`, `status` (`docs/FACTORY_CLI.md`)
- Agents: `escapement:scratchpad-planner` (plan, and one answer to the critique), `escapement:plan-critic` (Phase 3.55)
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

**Version:** 1.4.3
**Last Updated:** 2026-11-19
**Maintained By:** Escapement
**Changelog:**
- v1.4.3: Read context-path with `get-context-path.sh --absolute`, resolved from the main checkout, so lore and archives are found from any worktree (#88)
- v1.4.2: Factory path: Phase 3.55 step 5 mirrors the readiness document into the manifest again after the planner's round, as step 3d does, so the manifest never keeps the status from before it; only when the manifest database exists (#120, from #114)
- v1.4.1: Factory path: one readiness document, `factory check`'s full result plus setup-work's still-open questions, is brought up to date after the Q&A, mirrored into the manifest and given to the plan critic, so `browser_tests`, `tier` and `required_checks` reach the critic; the manifest's cut-down copy no longer overwrites it (#109)
- v1.4.0: Factory path: `browser_tests` from `factory check` goes to the planner, and in a project with browser tests UI criteria are planned as browser-test evidence, with `manual` kept for what a machine can't judge (#104)
- v1.3.0: Factory path: Phase 3.55, one round of fresh-context plan critique (the `plan-critic` agent) before approval; unresolved findings shown with both positions at the approval question; dispositions in `## Plan Critique` and on the run with `factory record-critique` (#99)
- v1.2.1: Fetch the issue with the GitHub MCP tools by name; access problems are checked through the MCP account (#80)
- v1.2.0: Factory path (docs/FACTORY_DESIGN.md §3): readiness, light context, proposed tier and validation contract when the project is set up for the factory; "Approve + authorize run" starts and approves a factory run. Unchanged otherwise (#63)
- v1.1.0: Added Task delegation to Explore agent, parallel execution, LSP integration, EnterPlanMode triggers
