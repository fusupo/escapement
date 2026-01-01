---
name: review-pr
description: Conduct comprehensive PR reviews with sprint/roadmap context awareness. Invoke when user says "review PR", "check this PR", "review pull request #X", or when asked to provide feedback on a PR.
tools:
  - mcp__github__*
  - mcp__linear__*
  - Read
  - Task
  - Grep
  - AskUserQuestion
---

# Review PR Skill

## Purpose

Conduct thorough, context-aware pull request reviews that consider the full project roadmap, sprint context, and epic hierarchy. This skill avoids suggesting improvements already planned in the backlog and focuses feedback on the specific scope of the PR.

## Natural Language Triggers

This skill activates when the user says things like:
- "Review PR #123"
- "Check this pull request"
- "Review this PR"
- "Give me feedback on PR #X"
- "What do you think of this PR?"
- Given a PR URL: "Review this: {url}"

## Workflow Execution

### Phase 1: Gather PR Context (Parallel)

Execute these in parallel:

1. **PR Details:**
   ```
   mcp__github__get_pull_request(owner, repo, pullNumber)
   mcp__github__get_pull_request_diff(owner, repo, pullNumber)
   mcp__github__get_pull_request_files(owner, repo, pullNumber)
   mcp__github__get_pull_request_comments(owner, repo, pullNumber)
   ```

2. **Project Context:**
   - Read project's `CLAUDE.md` for architecture and priorities
   - Understand current development phase

### Phase 2: Issue Hierarchy Detection

1. **Identify Closing Issue(s):**
   - Parse PR description for "Closes #X", "Fixes #X"
   - Get issue details

2. **Parent Issue Discovery:**
   - Check if closing issue is part of larger epic/initiative
   - Identify parent issue or milestone

3. **Sibling Issues:**
   - Find related issues in same parent/epic/sprint
   - Understand what else is planned

4. **Dependency Mapping:**
   - Find issues that depend on or block this work
   - Understand sequencing

### Phase 3: Sprint/Roadmap Context

1. **Current Sprint:**
   - List all issues in current sprint/milestone
   - Understand sprint goals

2. **Roadmap Position:**
   - Where does this work fit in project completion sequence?
   - What comes before and after?

3. **Remaining Work:**
   - What's left in this epic/feature area?
   - What improvements are already planned?

4. **Planned Improvements:**
   - Catalog backlog items for this area
   - Avoid suggesting work already captured

### Phase 4: Multi-Perspective Review

Execute each perspective while **avoiding suggestions already planned**:

#### 4.1 Product Value Assessment

**Focus:** Does this advance project capabilities toward stated goals?

- **Epic Progress:** How does this contribute to the larger feature?
- **Incremental Value:** What specific value does this deliver independently?
- **Sprint Completion:** Does this unblock other planned work?

**Output:** Assess business value within larger context. Skip suggestions already in sibling issues.

#### 4.2 Technical Implementation Review

**Focus:** Code quality appropriate for current velocity.

- **Architectural Fit:** Aligns with planned architecture from epic?
- **Integration Readiness:** Prepared for upcoming integration work?
- **Technical Debt:** Are shortcuts appropriate given upcoming refactoring?

**Output:** Review technical correctness within larger plan. Skip suggestions covered by planned tech debt issues.

#### 4.3 Epic Integration & Coordination

**Focus:** How this piece fits with related work.

- **Interface Consistency:** Establishes patterns others will follow?
- **Shared Components:** Reusable elements designed for sibling issues?
- **Integration Points:** Clean handoffs for dependent work?

**Output:** Evaluate coordination with planned work. Focus on enabling upcoming issues.

#### 4.4 Sprint-Aware Quality Assessment

**Focus:** Appropriate quality for current epic phase.

- **Functional Completeness:** Delivers scope without over-engineering?
- **Testing Strategy:** Appropriate for this piece vs. planned E2E tests later?
- **Documentation:** Needed now vs. planned for epic completion?

**Output:** Assess quality within sprint context. Defer suggestions scheduled for later.

#### 4.5 Roadmap Impact Analysis

**Focus:** Preparing for future work.

- **Epic Documentation:** Individual docs or wait for epic completion?
- **API Stability:** Stabilize now or changes planned?
- **Demo Readiness:** Can show independently or after epic?

**Output:** Evaluate within full roadmap. Highlight dependencies and coordination.

### Phase 5: Generate Review

**Review Structure:**

```markdown
## PR Review: #{pr_number} - {title}

### Context
- **Issue:** #{issue_number} - {issue_title}
- **Epic:** {parent epic if exists}
- **Sprint:** {current sprint/milestone}

### Summary
{Brief assessment of PR's contribution to project goals}

### Product Assessment
{Does this deliver intended value?}
{How does it advance the epic/project?}

### Technical Review
{Code quality observations}
{Architectural alignment}
{Integration considerations}

### Suggestions
{Only suggestions NOT already in backlog}
{Focus on this specific PR scope}

### Questions
{Clarifying questions if any}

### Verdict
{APPROVE / REQUEST_CHANGES / COMMENT}
{Summary of required changes if any}

---
**Context Awareness:**
- Reviewed against {N} related issues in epic
- Checked {M} planned improvements in backlog
- Aligned with sprint goals: {yes/no}
```

### Phase 6: Confirm and Submit Review

After generating the review, confirm with the user before submitting:

```
AskUserQuestion:
  question: "Submit this review to GitHub?"
  header: "Review"
  options:
    - label: "Submit as APPROVE"
      description: "Approve the PR with this review"
    - label: "Submit as REQUEST_CHANGES"
      description: "Request changes before approval"
    - label: "Submit as COMMENT"
      description: "Add review as comment without approval decision"
    - label: "Edit review first"
      description: "I want to modify the review before submitting"
    - label: "Don't submit"
      description: "Keep review local, don't post to GitHub"
```

If user chooses to submit:

```
mcp__github__create_and_submit_pull_request_review(
  owner, repo, pullNumber,
  body: "{review content}",
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
)
```

## Context-Aware Review Principles

1. **Epic-Scoped Feedback:** Consider the full feature being built
2. **Sprint Coordination:** Understand what's planned vs. missing
3. **Roadmap Respect:** Don't suggest work already in upcoming issues
4. **Dependency Awareness:** Focus on enabling downstream work
5. **Phase-Appropriate Quality:** Match expectations to epic timeline

## Error Handling

### PR Not Found
```
❌ Could not find PR #{number}
   Verify the PR number and repository.
```

### No Issue Linked
```
⚠️ PR has no linked issue.
   Review will proceed without epic/sprint context.
```

### Large PR Warning
```
⚠️ This PR has {N} files changed.
   Consider breaking into smaller PRs for easier review.
```

## Integration with Other Skills

**Reviews output from:**
- `create-pr` skill - Reviews PRs created by the workflow
- External contributors - Reviews incoming PRs

**Reads context from:**
- Project CLAUDE.md - Architecture and priorities
- GitHub/Linear - Issue hierarchy and roadmap

## Best Practices

### ✅ DO:
- Consider full project context before reviewing
- Check backlog before suggesting improvements
- Focus feedback on this PR's scope
- Acknowledge what the PR does well
- Be specific about requested changes

### ❌ DON'T:
- Suggest work already planned in backlog
- Request changes outside PR scope
- Over-engineer feedback for MVP-phase work
- Ignore epic/sprint context
- Be vague about concerns

---

**Version:** 1.1.0
**Last Updated:** 2025-12-31
**Maintained By:** Muleteer
**Changelog:**
- v1.1.0: Added AskUserQuestion for review submission confirmation
- v1.0.0: Initial conversion from commands/pr-review.md
