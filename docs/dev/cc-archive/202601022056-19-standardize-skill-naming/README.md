# Issue #19 - Standardize skill naming convention to consistent verb-noun pattern

**Archived:** 2026-01-02
**PR:** #20 (merged)
**Status:** Completed and Merged

## Summary

Standardized all Escapement skill names to follow a consistent **verb-noun** pattern, improving discoverability and mental model clarity. Renamed two skills:
- `issue-setup` → `setup-work` (broader scope, consistent pattern)
- `work-session` → `do-work` (natural English, action-oriented)

Other skills (`commit-changes`, `create-pr`, `review-pr`, `archive-work`, `prime-session`) already followed the pattern and required no changes.

## Key Decisions

**Naming Pattern Choice:**
- Adopted verb-noun pattern across all skills for consistency
- Chose `setup-work` over alternatives like `prepare-work` or `initialize-work` for broader scope beyond just GitHub issues
- Chose `do-work` for its natural English feel and action-oriented clarity

**Scope of Changes:**
- Archived work in `docs/dev/cc-archive/` intentionally NOT updated (historical record)
- Only active codebase files updated
- Natural language triggers preserved flexibility with updated skill descriptions

**Breaking Changes:**
- Explicit invocations changed: `/escapement:issue-setup` → `/escapement:setup-work`
- Explicit invocations changed: `/escapement:work-session` → `/escapement:do-work`
- Natural language invocations continue to work with updated trigger phrases

## Files Changed

**11 files modified across 6 atomic commits:**

### Commit 1: Rename directories and frontmatter
- `skills/issue-setup/` → `skills/setup-work/`
- `skills/work-session/` → `skills/do-work/`
- Updated `name:` fields in skill frontmatter

### Commit 2: Update CLAUDE.md
- Directory structure table
- Skills trigger examples
- Scratchpad convention references

### Commit 3: Update README.md
- Skills reference table
- Workflow narrative examples

### Commit 4: Update extended docs
- `docs/WORKFLOW.md` - skill references
- `docs/CUSTOMIZATION.md` - example references

### Commit 5: Update skill cross-references
- All `skills/*/SKILL.md` files - updated Skill() invocations
- Updated natural language trigger descriptions

### Commit 6: Update agent references
- `agents/scratchpad-planner.md` - references to setup-work skill

## Implementation Approach

**Atomic Commit Strategy:**
Each commit represented one logical change:
1. Directory renames and frontmatter updates (foundation)
2. Core project documentation (CLAUDE.md)
3. User-facing documentation (README.md)
4. Extended documentation (docs/)
5. Skill cross-references (inter-skill dependencies)
6. Agent references (specialized subagent updates)

**Verification Process:**
- Configuration verified (plugin.json, skill frontmatter)
- Directory structure validated
- Git status confirmed clean working tree
- All 6 commits pushed successfully

## Lessons Learned

**Consistency Matters:**
The inconsistent naming pattern (`issue-setup` and `work-session`) created friction for users trying to remember skill names. A consistent verb-noun pattern across all skills significantly improves discoverability.

**Breaking Changes Require Documentation:**
Clear documentation of breaking changes (explicit invocations) helps users adapt quickly.

**Atomic Commits Enable Clean History:**
Breaking the work into 6 atomic commits made the PR easy to review and understand the progression of changes.

**Natural Language Flexibility:**
Natural language triggers (`"setup issue #X"`, `"do work on issue #X"`) adapt well to new names, minimizing disruption for casual users.

---

**Work completed over 3 sessions:**
- Session 1: Directory renames and core documentation
- Session 2: Extended documentation and cross-references
- Session 3: Testing verification and PR creation

**Total commits:** 6 atomic commits
**PR:** #20 at https://github.com/fusupo/escapement/pull/20
**Merged:** 2026-01-02
