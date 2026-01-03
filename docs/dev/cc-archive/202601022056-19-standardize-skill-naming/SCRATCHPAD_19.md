# Standardize skill naming convention to consistent verb-noun pattern - #19

## Issue Details
- **Repository:** fusupo/escapement
- **GitHub URL:** https://github.com/fusupo/escapement/issues/19
- **State:** open
- **Labels:** None
- **Milestone:** None
- **Assignees:** None
- **Related Issues:** None

## Description

### Problem

The current skill naming convention is inconsistent:

- `issue-setup` - noun-verb (reversed pattern)
- `work-session` - noun-noun (conceptual)
- `commit-changes`, `create-pr`, `review-pr`, `archive-work`, `prime-session` - verb-noun (consistent)

This ad hoc evolution reduces discoverability and mental model clarity.

### Proposed Solution

Adopt consistent **verb-noun** pattern for all skills:

| Current | New | Rationale |
|---------|-----|-----------|
| `issue-setup` | `setup-work` | Broader scope (not just GitHub issues), consistent pattern |
| `work-session` | `do-work` | Natural English, action-oriented |
| `commit-changes` | `commit-changes` | ✓ No change |
| `create-pr` | `create-pr` | ✓ No change |
| `review-pr` | `review-pr` | ✓ No change |
| `archive-work` | `archive-work` | ✓ No change |
| `prime-session` | `prime-session` | ✓ No change |

### Workflow Narrative

```
prime-session    → Orient to project
setup-work       → Initialize work from issue
do-work          → Execute implementation
commit-changes   → Save atomic changes
create-pr        → Submit for review
review-pr        → Conduct review
archive-work     → Clean up and preserve
```

## Acceptance Criteria

- [ ] All skills follow consistent verb-noun naming pattern
- [ ] Natural language triggers still work as expected
- [ ] Explicit invocations work with new names
- [ ] All documentation reflects new naming
- [ ] Plugin loads without errors
- [ ] No broken references to old skill names

## Branch Strategy
- **Base branch:** main
- **Feature branch:** 19-standardize-skill-naming
- **Current branch:** main

## Implementation Checklist

### Setup
- [ ] Fetch latest from main
- [ ] Create and checkout feature branch 19-standardize-skill-naming

### 1. Rename Skill Directories
- [ ] Rename `skills/issue-setup/` → `skills/setup-work/`
  - Files affected: `skills/issue-setup/SKILL.md`
  - Why: Establish new directory structure for setup-work skill

- [ ] Rename `skills/work-session/` → `skills/do-work/`
  - Files affected: `skills/work-session/SKILL.md`
  - Why: Establish new directory structure for do-work skill

### 2. Update Skill Frontmatter
- [ ] Update `skills/setup-work/SKILL.md` - Change `name:` field to `setup-work`
  - Files affected: `skills/setup-work/SKILL.md`
  - Why: Plugin uses name field for skill registration

- [ ] Update `skills/do-work/SKILL.md` - Change `name:` field to `do-work`
  - Files affected: `skills/do-work/SKILL.md`
  - Why: Plugin uses name field for skill registration

### 3. Update Documentation - CLAUDE.md
- [ ] Update `CLAUDE.md` - Skills reference table (line ~24-30 directory structure)
  - Files affected: `CLAUDE.md`
  - Why: Documentation must reflect new directory names

- [ ] Update `CLAUDE.md` - Skills table trigger examples (line ~54-62)
  - Files affected: `CLAUDE.md`
  - Why: Update skill names and trigger examples

- [ ] Update `CLAUDE.md` - Scratchpad convention comment (line ~128)
  - Files affected: `CLAUDE.md`
  - Why: Update reference from issue-setup to setup-work

### 4. Update Documentation - README.md
- [ ] Update `README.md` - Skills table
  - Files affected: `README.md`
  - Why: User-facing documentation must reflect new names

- [ ] Update `README.md` - Workflow narrative examples
  - Files affected: `README.md`
  - Why: Ensure examples use new skill names

### 5. Update Documentation - docs/
- [ ] Update `docs/WORKFLOW.md` - Skill references
  - Files affected: `docs/WORKFLOW.md`
  - Why: Workflow documentation must use new skill names

- [ ] Update `docs/CUSTOMIZATION.md` - Example references
  - Files affected: `docs/CUSTOMIZATION.md`
  - Why: Customization examples must use new skill names

### 6. Update Skill Cross-References
- [ ] Search and replace `/escapement:issue-setup` → `/escapement:setup-work` in all skills
  - Files affected: All `skills/*/SKILL.md` files
  - Why: Skills may reference each other

- [ ] Search and replace `/escapement:work-session` → `/escapement:do-work` in all skills
  - Files affected: All `skills/*/SKILL.md` files
  - Why: Skills may reference each other

- [ ] Update any Skill tool invocations in skill content
  - Files affected: Skill markdown content sections
  - Why: Ensure Skill() calls use new names

### 7. Quality Checks
- [ ] Search entire codebase for remaining "issue-setup" references
  - Files affected: All files
  - Why: Catch any missed references

- [ ] Search entire codebase for remaining "work-session" references
  - Files affected: All files
  - Why: Catch any missed references

- [ ] Verify no broken links or references
  - Files affected: All documentation
  - Why: Ensure documentation integrity

### 8. Testing
- [ ] Test `setup-work` skill invocation via natural language
  - Why: Verify natural language triggers work

- [ ] Test `do-work` skill invocation via natural language
  - Why: Verify natural language triggers work

- [ ] Test explicit invocation: `/escapement:setup-work`
  - Why: Verify explicit skill name works

- [ ] Test explicit invocation: `/escapement:do-work`
  - Why: Verify explicit skill name works

- [ ] Verify plugin loads without errors
  - Why: Ensure no configuration issues

- [ ] Verify `/help` shows updated skill names
  - Why: Confirm skills registered correctly

## Technical Notes

### Architecture Considerations

**This is a breaking change** for users invoking skills explicitly:
- `/escapement:issue-setup` → `/escapement:setup-work`
- `/escapement:work-session` → `/escapement:do-work`

Natural language invocation should continue to work with updated trigger phrases in skill descriptions.

### Implementation Approach

1. **Atomic commits by task group:**
   - Commit 1: Rename directories and update frontmatter
   - Commit 2: Update CLAUDE.md references
   - Commit 3: Update README.md references
   - Commit 4: Update docs/ references
   - Commit 5: Update skill cross-references
   - Commit 6: Final verification and cleanup

2. **Search strategy:**
   - Use grep/ripgrep to find all references
   - Update in logical groups (by file type/purpose)
   - Verify each change maintains context

3. **Testing approach:**
   - Test after each major change group
   - Use `claude --plugin-dir .` for validation
   - Verify both natural language and explicit invocation

### Potential Challenges

1. **Hidden references:** May be references in archived work or comments
2. **User muscle memory:** Users accustomed to old names will need to adapt
3. **Documentation lag:** External docs or blog posts may reference old names

### Files Requiring Changes

**Skill directories:**
- `skills/issue-setup/` → `skills/setup-work/`
- `skills/work-session/` → `skills/do-work/`

**Skill frontmatter:**
- `skills/setup-work/SKILL.md`
- `skills/do-work/SKILL.md`

**Core documentation:**
- `CLAUDE.md` (multiple sections)
- `README.md` (skills table, workflow examples)

**Extended documentation:**
- `docs/WORKFLOW.md`
- `docs/CUSTOMIZATION.md`

**Cross-references:**
- All `skills/*/SKILL.md` files (check for Skill() invocations)
- Any agent files that reference skills

## Questions/Blockers

### Clarifications Needed
(None at this time - issue is very well-specified)

### Blocked By
(None)

### Assumptions Made
- Archived work in `docs/dev/cc-archive/` does NOT need updating (historical record)
- Only active codebase files need updates
- Natural language triggers are flexible enough to handle new names

### Decisions Made
(To be filled during implementation)

## Work Log

---
**Generated:** 2026-01-02
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/escapement/issues/19
