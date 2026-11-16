---
name: create-pr
description: Create context-aware pull requests with issue integration. Invoke when user says "create a PR", "open pull request", "make a PR", "submit for review", or after completing work on a feature branch.
tools:
  - Bash:git *
  - Bash:gh *
  - Bash:bash *
  - mcp__github__*
  - mcp__linear__*
  - Read
  - Write
  - AskUserQuestion
---

# Create PR Skill

## Purpose

Create well-structured pull requests that link to originating issues, summarize changes clearly, and facilitate effective code review. This skill analyzes the branch, detects related issues, and generates comprehensive PR descriptions.

## Natural Language Triggers

This skill activates when the user says things like:
- "Create a PR"
- "Open a pull request"
- "Make a PR for this work"
- "Submit this for review"
- "I'm ready to create a pull request"
- "PR this branch"
- After work completion: "Done, let's open a PR"

## Workflow Execution

### Phase 0: Authorized Run Check

A factory run approved with setup-work's "Approve + authorize run" opens its own PR, as the AI agent's GitHub identity, with its validation report in the description (docs/FACTORY_DESIGN.md §4.8, §6.1). Ask the runner whether this worktree has one:

```bash
FACTORY="${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"
bash "$FACTORY" --check && bash "$FACTORY" --json authorization
```

- **`--check` fails, or `.result.matched` is false:** not authorized. Skip this phase; everything below runs exactly as written.
- **Matched, `next` is `await_merge`:** the PR is open and already shows the current report. Report `.result.pr_number` and stop.
- **Matched, but `.result.authorizes` lacks `open_pr`, or `.result.next` is neither `pr` nor `refresh_pr`:** stop without opening a PR: "Factory run {run_id} has no passing validation report yet (state {state}, next {next}). Run validate-work first." Don't fall back to opening a PR another way: an authorized branch only gets a PR with its report.
- **Matched, `next` is `pr` or `refresh_pr`:** authorized. Note `.result.run_id`, `.result.artifact_dir` and `.result.target_ref`, the base branch.

**Under authorization:**
- Phases 1–4 run as written, with `{target_ref}` as the base. The issue text may already be in `{artifact_dir}/issue.md` (validate-work wrote it); reuse it. The description's Testing section can point at the validation report, which the runner appends.
- **Phase 5 is skipped.** Show the title and description; don't ask.
- **Phase 6 is replaced.** Never `git push`, `gh pr create`, the GitHub MCP tools or labels yourself: the runner pushes the run's branch and opens or updates the PR as the agent. Write the description with the Write tool to `{artifact_dir}/pr/narrative.md` (the artifact dir, never the worktree), then:
  ```bash
  bash "$FACTORY" --json pr '{run_id}' --title '{title}' --body-file '{artifact_dir}/pr/narrative.md'
  ```
  Single-quote the run ID and title (a `'` in the title is written `'\''`). For `refresh_pr` the title is optional; the PR keeps its own unless you pass one.
  - **`.ok`:** report `.result.url`, `.result.pr_number` and `.result.action`: `created`, `updated`, or `recovered` (an earlier, interrupted call had created it). Running it again is safe: it finds the PR an earlier call created.
  - **No JSON, or exit status 128 or more:** the runner died, possibly after GitHub created the PR. Run the same command again: the lookup finds that PR and records it (`action: recovered`), never a second one.
  - **`gh_failed` or `push_failed`** (exit 1): GitHub may have acted before the failure. Run the same command once more; it finds a PR an earlier call created. If it fails again, report it and stop.
  - **Refused** (exit 2, `.error.code`): report the code and message and stop; under do-work, the caller decides whether to escalate. `head_moved` means commits came after validation, or the tree is dirty (validate again); `no_agent_token` means ESCAPEMENT_AGENT_GH_TOKEN isn't set (environment or `~/.config/escapement/agent.env`); `run_deadline` means the run was escalated.

### Phase 1: Gather Context (Parallel)

Execute these in parallel for efficiency:

1. **Project Context:**
   - Read project's `CLAUDE.md` for PR conventions
   - Identify target branch (main, develop, etc.)

2. **Branch Analysis:**
   - `git branch --show-current` - Current branch name
   - `git log main..HEAD --oneline` - Commits on this branch
   - `git diff main...HEAD --stat` - Change summary

3. **Remote Status:**
   - Check if branch is pushed to remote
   - Check if remote is up to date

### Phase 2: Detect Issue Context

1. **Extract Issue Reference from Branch Name:**

   Common patterns:
   - `42-feature-description` → Issue #42
   - `feature/42-description` → Issue #42
   - `fix/123-bug-name` → Issue #123
   - `ABC-123-description` → Linear issue ABC-123

2. **Retrieve Issue Details:**

   **For GitHub Issues:**
   ```
   mcp__github__get_issue(owner, repo, issue_number)
   ```
   - Get title, description, acceptance criteria
   - Get labels for PR labeling
   - Check issue state (should be open)

   **For Linear Issues:**
   ```
   mcp__linear__get_issue(id)
   ```
   - Get issue details and context

3. **Build Context Map:**
   - Original issue requirements
   - Acceptance criteria to verify
   - Related issues (blocks, depends on)
   - Milestone/project context

### Phase 3: Analyze Changes

1. **Commit Analysis:**
   - Review each commit message
   - Identify modules affected
   - Categorize change types (feat, fix, etc.)

2. **Change Summary:**
   - Files changed and why
   - Key functionality added/modified
   - Breaking changes (if any)

3. **Verify Completeness:**
   - Do commits address the issue requirements?
   - Are acceptance criteria met?
   - Any outstanding work?

### Phase 4: Generate PR Content

**PR Title:**
Format: `{type}: {description} (#{issue_number})`

Example: `feat: Add commit-changes skill (#42)`

**PR Description Template:**
```markdown
## Summary
{Brief explanation aligned with original issue goals}

## Issue Resolution
Closes #{issue_number}

{How this implementation addresses the original requirements}

## Key Changes
- {Module-focused change descriptions}
- {New capabilities enabled}
- {Breaking changes if any}

## Implementation Notes
{Any deviations from issue description}
{Technical decisions made}
{Trade-offs considered}

## Testing
{How this was tested}
{What testing is appropriate for current project phase}

## Checklist
- [ ] Code follows project conventions
- [ ] Changes are atomic and reviewable
- [ ] Documentation updated (if needed)
- [ ] Tests added/updated (if applicable)
```

### Phase 5: Confirm with User

Under an authorized run (Phase 0), skip this phase. Otherwise use `AskUserQuestion` to confirm PR details:

```
AskUserQuestion:
  question: "Ready to create this PR?"
  header: "Create PR"
  options:
    - label: "Yes, create PR"
      description: "Create the PR with this title and description"
    - label: "Edit title"
      description: "I want to modify the PR title"
    - label: "Edit description"
      description: "I want to modify the PR description"
    - label: "Create as draft"
      description: "Create as draft PR (not ready for review)"
    - label: "Cancel"
      description: "Don't create PR right now"
```

Display the proposed title and description before asking.

### Phase 6: Create Pull Request

Under an authorized run, Phase 0 replaces this phase (`factory pr`).

1. **Ensure branch is pushed:**
   ```bash
   git push -u origin {branch-name}
   ```

2. **Create PR using gh CLI:**
   ```bash
   gh pr create \
     --title "{title}" \
     --body "$(cat <<'EOF'
   {PR description}
   EOF
   )" \
     --base {target-branch}
   ```

   Or use MCP GitHub tools:
   ```
   mcp__github__create_pull_request(...)
   ```

   **IMPORTANT:** Do NOT add Claude attribution (e.g., "Generated with Claude Code") to PR descriptions.

3. **Apply labels** (from issue + modules affected)

4. **Link to issue** (auto-close on merge via "Closes #X")

### Phase 7: Report Result

Display:
```
✓ Pull Request created!

🔗 PR #XX: {title}
   {PR URL}

📋 Linked to Issue #{issue_number}

👀 Ready for review
   Target: {target-branch}
   Reviewers: {if any suggested}
```

## Auto-Configuration

Based on context, automatically determine:

1. **Target Branch:**
   - Check CLAUDE.md for project conventions
   - Default: main or develop (whichever exists)

2. **Labels:**
   - From originating issue
   - From modules affected (if label mapping exists)
   - Change type (enhancement, bug, etc.)

3. **Draft Status:**
   - Set draft if branch contains "wip" or "draft"
   - Set draft if issue is incomplete
   - Ask user if uncertain

4. **Reviewers:**
   - Suggest based on CODEOWNERS
   - Suggest based on issue assignees
   - Suggest based on module ownership

## Error Handling

### No Commits on Branch
```
ℹ️ No commits to create PR from.
   Branch has no changes vs {target-branch}.
```

### Branch Not Pushed
```
📤 Branch not on remote. Pushing now...
   git push -u origin {branch}
```

### Issue Not Found
```
⚠️ Could not find issue reference in branch name.
   Branch: {branch-name}

   Would you like to:
   1. Enter issue number manually
   2. Create PR without issue link
   3. Cancel
```

### PR Already Exists
```
ℹ️ PR already exists for this branch.
   🔗 PR #{number}: {title}

   Would you like to update it instead?
```

## Integration with Other Skills

**Follows:**
- `do-work` skill - After completing all tasks (under an authorized run, after validate-work passes)
- `commit-changes` skill - After final commit

**Calls:**
- `scripts/factory.sh` `authorization` and `pr` (Phase 0; docs/FACTORY_CLI.md)

**Links to:**
- GitHub Issues - Auto-close on merge
- Linear Issues - Link and track

## Best Practices

### ✅ DO:
- Link PRs to originating issues
- Write clear, context-rich descriptions
- Include testing information
- Note any deviations from original requirements
- Use conventional PR titles

### ❌ DON'T:
- Create PRs for incomplete work (use draft instead)
- Skip the issue link
- Write vague descriptions
- Include unrelated changes
- Force push after PR is created (without warning)
- Add Claude attribution to PR descriptions

---

**Version:** 1.2.0
**Last Updated:** 2026-11-16
**Maintained By:** Escapement
**Converted From:** commands/open-pr.md
**Changelog:**
- v1.2.0: Under authorization, a `factory pr` that dies without JSON is run again; the lookup records the PR it created (#65)
- v1.1.0: Under a matching active factory authorization, open or update the PR through `factory pr` (as the AI agent, with the validation report), without confirmation; refuse without a passing report (#64)
