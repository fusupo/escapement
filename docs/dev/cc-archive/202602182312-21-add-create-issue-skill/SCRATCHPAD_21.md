# Add create-issue Skill for GitHub/Linear Issue Creation - #21

## Issue Details
- **Repository:** fusupo/escapement
- **GitHub URL:** https://github.com/fusupo/escapement/issues/21
- **State:** open
- **Labels:** enhancement
- **Milestone:** none
- **Assignees:** none
- **Related Issues:** none

## Description

Add a new Escapement skill that creates issues on GitHub (and optionally Linear) directly from natural language prompts within a Claude Code session. Currently, creating issues requires leaving the coding session to visit GitHub/Linear. A `create-issue` skill keeps developers in flow by allowing issue creation inline, with automatic context from the current project.

**Key design insight:** This skill is used **ad hoc**, often mid-flow while working on something else. An idea pops into the operator's head and they want to capture it without breaking stride. The issue may relate to current work or be completely orthogonal. The skill must be lightweight and conversational - not a heavy ceremony.

## Acceptance Criteria
- [x] Skill file at `skills/create-issue/SKILL.md`
- [x] Supports GitHub issue creation via MCP
- [x] Interactive confirmation before submission
- [x] Returns issue URL after creation
- [x] Documented in README skill table

## Branch Strategy
- **Base branch:** main
- **Feature branch:** 21-add-create-issue-skill
- **Current branch:** main

## Implementation Checklist

### Setup
- [ ] Fetch latest from main
- [ ] Create and checkout feature branch

### Implementation Tasks

- [ ] Create `skills/create-issue/SKILL.md`
  - Files: `skills/create-issue/SKILL.md` (new)
  - Why: Primary deliverable - the skill definition with frontmatter, workflow, error handling
  - Design philosophy: **lightweight, conversational, non-disruptive**
  - Workflow phases:
    - Phase 1: Quick Context (detect owner/repo from git remote, opportunistically note current work context)
    - Phase 2: Refine Intent (ask clarifying questions to flesh out vague ideas - this is the core interaction)
    - Phase 3: Draft & Confirm (compose issue, show preview, confirm before creation)
    - Phase 4: Create & Report (create via MCP, return URL, optionally offer setup-work)

- [ ] Update README.md and CLAUDE.md with new skill
  - Files: `README.md`, `CLAUDE.md`
  - Why: Acceptance criteria requires README documentation; CLAUDE.md keeps developer-facing docs in sync
  - Changes:
    - Add `create-issue` row to Available Skills table in README
    - Add `create-issue/` to Structure tree in README
    - Add `create-issue` row to Skills table in CLAUDE.md
    - Add `create-issue/` to Directory Structure in CLAUDE.md

### Quality Checks
- [ ] Verify SKILL.md frontmatter follows established conventions
- [ ] Self-review for consistency with other skills

## Technical Notes

### Architecture Considerations
- **Ad hoc tool**, not a ceremony - designed for mid-flow idea capture
- Fits in the "Initialize" phase of the workflow but can be used standalone
- Natural chain: `create-issue` -> optionally `setup-work` (but only if operator wants to work on it now)
- No agent delegation needed
- No git operations beyond `git remote -v` for repo detection

### Implementation Approach

**Core interaction pattern: Conversational refinement**

The operator says something vague like "file a bug about the login timeout" or "create an issue to track refactoring the auth module". The skill should:

1. **Quickly detect context** - owner/repo from git remote (fast, no ceremony)
2. **Ask clarifying questions** - This is the heart of the skill. Use AskUserQuestion to:
   - Confirm/refine the title
   - Ask for more detail on the problem/feature if the prompt is vague
   - Suggest issue type (bug, enhancement, task) based on phrasing
   - Suggest labels if relevant (but don't over-ask - keep it light)
   - Ask about assignee only if relevant
3. **Draft and preview** - Show the composed issue for final approval
4. **Create and report** - Submit, show URL, offer to chain to setup-work

**Key principle:** If the operator's initial prompt is already detailed, skip most clarifying questions. If it's vague ("file a bug about X"), ask enough to make a useful issue but don't over-interrogate.

**Context awareness:** The skill can optionally read CLAUDE.md for label conventions and module names, but this is opportunistic enrichment, not a blocking requirement. The skill works fine without it.

### Potential Challenges
- Balancing "ask enough questions" vs "don't slow me down" - the skill instructions need to guide Claude on when to ask vs when to proceed

## Questions/Blockers

### Clarifications Needed
None - all resolved.

### Decisions Made
1. **Linear scope** -> GitHub only for v1. Linear support deferred to follow-up issue.
2. **Future Linear detection** -> When added, default GitHub with "Create on Linear instead" option.
3. **Usage context** -> Ad hoc, mid-flow tool. Not a ceremony. Designed for capturing ideas without breaking stride.
4. **Clarifying questions emphasis** -> Core interaction is conversational refinement. Ask enough to make a good issue, don't over-interrogate.

### Assumptions Made
- Using `mcp__github__*` wildcard in frontmatter (consistent with other skills)
- Following the same section structure as existing skills
- Two commits: one for skill file, one for docs updates

## Work Log

### 2026-02-18 - Session Complete
- Created `skills/create-issue/SKILL.md` (287 lines)
  - Commit: `0be67d6` 🎯✨ feat(skills): Add create-issue skill for ad hoc GitHub issue creation
- Updated README.md and CLAUDE.md with new skill entries
  - Commit: `85c89f2` 🎯📝 docs(skills): Document create-issue skill in README and CLAUDE.md
- Quality check passed: frontmatter conventions, section structure consistent
- All acceptance criteria met
- Ready for PR

---
**Generated:** 2026-02-18
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/escapement/issues/21
