---
name: create-pr
description: Create context-aware pull requests with issue integration. Invoke when user says "create a PR", "open pull request", "make a PR", "submit for review", or after completing work on a feature branch.
tools:
  - Bash:git *
  - Bash:gh *
  - mcp__github__*
  - mcp__linear__*
  - Read
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

Use `AskUserQuestion` to confirm PR details:

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
- `do-work` skill - After completing all tasks
- `commit-changes` skill - After final commit

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

**Version:** 1.0.0
**Last Updated:** 2025-12-29
**Maintained By:** Escapement
**Converted From:** commands/open-pr.md
