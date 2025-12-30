# Rearchitect commands as skills for automatic invocation - #2

## Issue Details
- **Repository:** fusupo/muleteer
- **GitHub URL:** https://github.com/fusupo/muleteer/issues/2
- **State:** open
- **Labels:** enhancement
- **Milestone:** None
- **Assignees:** None
- **Related Issues:**
  - Blocks: #3 (Integrate Claude Code affordances throughout workflow)
  - Related: #1 (Documentation), #4 (Testing), #5 (Hooks)

## Description

Current Muleteer workflow relies on slash-commands (`/commit`, `/open-pr`, etc.) that require explicit invocation. This creates a command-line-like experience rather than a conversational workflow with Claude Code.

Claude Code supports **skills** that can be invoked automatically based on natural language context. We should leverage this to create a more seamless, integrated workflow.

### Goals

Convert explicit commands to automatic skills that Claude invokes contextually:

- `/commit` → `commit-changes` skill (triggered by "commit these changes")
- `/open-pr` → `create-pr` skill (triggered by "create a PR")
- `/pr-review` → `review-pr` skill (triggered by "review PR #123")
- `/start-work` → `work-session` skill (triggered by "start working on issue #42")
- `/archive-dev` → `archive-work` skill (triggered by "archive this work")
- `/prime-session` → evaluate automatic invocation vs explicit

## Acceptance Criteria
- [ ] Users can trigger workflow actions with natural language (no slash-commands required)
- [ ] Each skill has clear frontmatter defining when it should activate
- [ ] Skills are invoked automatically when context matches
- [ ] Commands directory either removed or contains only true utilities
- [ ] Skills use Claude Code affordances (TodoWrite, parallel calls, etc.)
- [ ] Documentation explains skill invocation patterns

## Branch Strategy
- **Base branch:** main
- **Feature branch:** 2-rearchitect-commands-as-skills
- **Current branch:** main

## Implementation Checklist

### Setup
- [x] Fetch latest from main branch
- [x] Create and checkout feature branch `2-rearchitect-commands-as-skills`

### Implementation Tasks

#### Task 1: Create `commit-changes` skill
- [x] Create `skills/commit-changes/SKILL.md`
  - Files affected: `skills/commit-changes/SKILL.md` (new)
  - Why: Convert `/commit` command to automatic skill
  - Source: `commands/commit.md` (124 lines)
  - Enhancements:
    - Add natural language trigger patterns
    - Integrate AskUserQuestion for commit approval
    - Use parallel tool calls for git status + diff
    - Add TodoWrite integration for tracking

#### Task 2: Create `create-pr` skill
- [x] Create `skills/create-pr/SKILL.md`
  - Files affected: `skills/create-pr/SKILL.md` (new)
  - Why: Convert `/open-pr` command to automatic skill
  - Source: `commands/open-pr.md` (67 lines)
  - Enhancements:
    - Natural language triggers ("create a PR", "open pull request")
    - Auto-detect issue from branch name
    - Use GitHub MCP tools for PR creation
    - AskUserQuestion for PR details confirmation

#### Task 3: Create `review-pr` skill
- [x] Create `skills/review-pr/SKILL.md`
  - Files affected: `skills/review-pr/SKILL.md` (new)
  - Why: Convert `/pr-review` command to automatic skill
  - Source: `commands/pr-review.md` (86 lines)
  - Enhancements:
    - Natural language triggers ("review PR #X", "check this PR")
    - Use Task tool for delegating analysis to Explore agent
    - Parallel fetching of PR details, comments, diff
    - Structured review output

#### Task 4: Create `work-session` skill
- [x] Create `skills/work-session/SKILL.md`
  - Files affected: `skills/work-session/SKILL.md` (new)
  - Why: Convert `/start-work` command to automatic skill
  - Source: `commands/start-work.md` (61 lines)
  - Enhancements:
    - Natural language triggers ("start working on issue #X", "continue work")
    - TodoWrite integration for scratchpad tasks
    - Sync TodoWrite with scratchpad checklist
    - Call `commit-changes` skill after task completion (with confirmation)
    - Track progress in both TodoWrite (transient) and scratchpad (persistent)

#### Task 5: Create `archive-work` skill
- [x] Create `skills/archive-work/SKILL.md`
  - Files affected: `skills/archive-work/SKILL.md` (new)
  - Why: Convert `/archive-dev` command to automatic skill
  - Source: `commands/archive-dev.md` (3 lines)
  - Enhancements:
    - Natural language triggers ("archive this work", "clean up scratchpad")
    - Auto-detect scratchpad from current branch/context
    - Create archive directory structure if needed
    - Generate summary of completed work

#### Task 6: Create `prime-session` skill (auto-invoke)
- [x] Create `skills/prime-session/SKILL.md`
  - Files affected: `skills/prime-session/SKILL.md` (new)
  - Why: Convert to auto-invoke skill per Q&A decision
  - Source: `commands/prime-session.md` (4 lines)
  - Enhancements:
    - Auto-invoke when Claude detects new/unfamiliar repo
    - Read CLAUDE.md, README.md, architecture docs
    - Provide orientation summary without taking action
    - Trigger: Entering new repo, or explicit "orient me to this project"

#### Task 7: Update install.sh for new skills
- [x] Modify `install.sh` to handle new skill directories
  - Files affected: `install.sh`
  - Why: Ensure new skills are symlinked to `~/.claude/skills/`
  - Changes:
    - Already handles skills directory (should work automatically)
    - Verify symlink creation for new skills

#### Task 8: Remove commands directory (clean break)
- [x] Delete commands/ directory entirely
  - Files affected: `commands/` directory (remove all)
  - Why: Per Q&A decision - clean break, skills replace commands entirely
  - Steps:
    - Remove `commands/commit.md`
    - Remove `commands/open-pr.md`
    - Remove `commands/pr-review.md`
    - Remove `commands/start-work.md`
    - Remove `commands/archive-dev.md`
    - Remove `commands/prime-session.md`
    - Remove `commands/` directory
  - Update `install.sh` to remove commands symlink logic (if needed)

#### Task 9: Update CLAUDE.md documentation
- [x] Update project CLAUDE.md to reflect skill-based architecture
  - Files affected: `CLAUDE.md`
  - Why: Ensure documentation matches new architecture
  - Changes:
    - Update "Key Components" section
    - Add skill invocation patterns
    - Update directory structure diagram
    - Document natural language triggers

### Quality Checks
- [ ] Test each skill invocation with natural language
- [ ] Verify skills are symlinked correctly after `install.sh`
- [ ] Test skill composition (work-session calling commit-changes)
- [ ] Verify TodoWrite integration works correctly
- [ ] Self-review for code quality and consistency

### Documentation
- [ ] Add inline comments explaining skill trigger patterns
- [ ] Document skill invocation examples in each SKILL.md
- [ ] Update README.md if needed

### Finalization
- [ ] Review all commits for clarity
- [ ] Ensure commit messages follow convention
- [ ] Final self-review before PR

## Technical Notes

### Architecture Considerations

**Skill Directory Structure (after rearchitecture):**
```
skills/
├── issue-setup/          # Existing skill
│   └── SKILL.md
├── commit-changes/       # New - from /commit
│   └── SKILL.md
├── create-pr/            # New - from /open-pr
│   └── SKILL.md
├── review-pr/            # New - from /pr-review
│   └── SKILL.md
├── work-session/         # New - from /start-work
│   └── SKILL.md
├── archive-work/         # New - from /archive-dev
│   └── SKILL.md
└── prime-session/        # New - from /prime-session (auto-invoke)
    └── SKILL.md
```

**Note:** `commands/` directory will be removed entirely (per Q&A decision).

**Skill Frontmatter Pattern:**
```yaml
---
name: skill-name
description: What this skill does and when to invoke it
tools:
  - tool:pattern
  - tool:*
---
```

**Natural Language Trigger Patterns:**
Each skill should document natural language patterns that indicate when it should activate. These go in the skill description and body.

### Implementation Approach

**Conversion Strategy:**
1. Create new skill directory for each command
2. Migrate content from command to skill format
3. Enhance with Claude Code affordances
4. Add natural language trigger documentation
5. Test invocation
6. Clean up original command

**Claude Code Affordances to Integrate:**
- **TodoWrite**: Track progress during work-session
- **AskUserQuestion**: Confirm actions (commits, PRs)
- **Task tool**: Delegate complex analysis
- **Parallel tool calls**: Fetch multiple things simultaneously

**Skill Composition:**
- `work-session` can invoke `commit-changes` skill
- `create-pr` follows naturally after `work-session` completion
- Skills should be independently usable but compose well

### Potential Challenges

1. **Trigger Ambiguity**: Multiple skills might match same natural language. Need clear, distinct trigger patterns.

2. **Backward Compatibility**: Users expecting `/command` syntax may be confused. Consider keeping commands as thin wrappers initially.

3. **State Management**: Skills need consistent way to detect context (current branch, scratchpad existence, etc.)

4. **Skill Invocation**: Need to understand how Claude Code actually invokes skills - automatic vs explicit `Skill` tool.

5. **TodoWrite + Scratchpad Sync**: Keeping both in sync without duplication requires careful design.

## Questions/Blockers

### Clarifications Needed

*All clarifications resolved via Q&A - see Decisions Made below*

### Blocked By
- None - this is foundational work

### Assumptions Made

1. The existing `issue-setup` skill structure is the correct pattern to follow.

2. TodoWrite and scratchpad can coexist with TodoWrite showing current session progress and scratchpad being persistent record.

### Decisions Made
*Resolved 2025-12-29 via Interactive Q&A*

**Q: How should we handle skill auto-invocation?**
**A:** Hybrid approach
**Rationale:** Skills can be invoked automatically by Claude matching natural language to skill descriptions, OR explicitly via the Skill tool. This provides flexibility - users can trigger skills conversationally or programmatically.

**Q: Should we keep commands as aliases/wrappers during the transition?**
**A:** Remove immediately (clean break)
**Rationale:** No backward compatibility layer needed. Skills replace commands entirely. This keeps the architecture clean and avoids confusion about which to use.

**Q: How should prime-session be handled?**
**A:** Convert to auto-invoke skill
**Rationale:** Should activate automatically when Claude detects a new/unfamiliar repo. This provides seamless orientation without requiring user to remember to invoke it.

## Work Log

### 2025-12-28 - Implementation Session

**Completed all 9 implementation tasks:**

1. Created `skills/commit-changes/SKILL.md` (246 lines)
   - Conventional commits with emojis
   - AskUserQuestion for commit confirmation
   - Smart staging logic

2. Created `skills/create-pr/SKILL.md` (230 lines)
   - Auto-detect issue from branch name
   - GitHub MCP integration
   - PR template generation

3. Created `skills/review-pr/SKILL.md` (250 lines)
   - Multi-perspective review framework
   - Sprint/roadmap context awareness
   - Parallel PR data fetching

4. Created `skills/work-session/SKILL.md` (322 lines)
   - TodoWrite + scratchpad sync
   - Task-by-task execution
   - Skill composition (calls commit-changes)

5. Created `skills/archive-work/SKILL.md` (282 lines)
   - Archive directory structure
   - Summary README generation
   - AskUserQuestion for confirmation

6. Created `skills/prime-session/SKILL.md` (281 lines)
   - Auto-invoke on new repo detection
   - Project orientation without action
   - Reads CLAUDE.md, README.md, architecture docs

7. Updated `install.sh`
   - Added cleanup of old command symlinks
   - Removed commands symlink logic
   - Updated output messaging

8. Removed `commands/` directory entirely
   - Deleted all 6 command files
   - Clean break per Q&A decision

9. Updated `CLAUDE.md` documentation
   - Skill-based architecture
   - Natural language trigger examples
   - Updated directory structure

**Ready for commit and PR creation.**

---
**Generated:** 2025-12-29
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/muleteer/issues/2
