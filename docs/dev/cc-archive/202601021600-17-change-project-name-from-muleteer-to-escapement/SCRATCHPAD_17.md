# Change project name from muleteer to escapement - #17

## Issue Details
- **Repository:** fusupo/muleteer
- **GitHub URL:** https://github.com/fusupo/muleteer/issues/17
- **State:** open
- **Labels:** None
- **Milestone:** None
- **Assignees:** None
- **Related Issues:** None

## Description
> while 'muleteer' fits I feel in my gut its a bit insulting to the tool and the audience i might be trying to speak to with this. 'escapement' fits as well, and gives some other flatery to a sense of measure and control

## Acceptance Criteria
- [ ] Plugin identifier changed from "muleteer" to "escapement"
- [ ] All skill invocations updated from `/muleteer:*` to `/escapement:*`
- [ ] Documentation updated to reference "Escapement" consistently
- [ ] Plugin marketplace listing updated
- [ ] Plugin works correctly with new name
- [ ] No broken references or outdated "muleteer" mentions in active code/docs

## Branch Strategy
- **Base branch:** main
- **Feature branch:** 17-change-project-name-from-muleteer-to-escapement
- **Current branch:** main

## Implementation Checklist

### Setup
- [ ] Fetch latest from base branch
- [ ] Create and checkout feature branch

### Priority 1: CRITICAL Plugin Infrastructure (Must work for plugin to function)

- [ ] Update plugin manifest identifier
  - Files affected: `.claude-plugin/plugin.json`
  - Change: Line 2 `"name": "muleteer"` → `"name": "escapement"`
  - Why: Core plugin identifier - affects skill invocation namespace

- [ ] Update marketplace listing
  - Files affected: `.claude-plugin/marketplace.json`
  - Change: Lines 2, 12 - Plugin name references
  - Why: Marketplace identity and discovery

- [ ] Update README.md skill invocation examples
  - Files affected: `README.md`
  - Change: Lines 44, 150, 151 - `/muleteer:skill-name` → `/escapement:skill-name`
  - Why: User documentation must show correct invocation syntax

- [ ] Update CLAUDE.md skill invocation syntax
  - Files affected: `CLAUDE.md`
  - Change: Lines 8, 44, 52, 166 - Plugin name and invocation examples
  - Why: Project instructions must reflect correct plugin usage

### Priority 2: HIGH User-Facing Documentation

- [ ] Update README.md title and descriptions
  - Files affected: `README.md`
  - Change: Replace all "Muleteer" → "Escapement" (18 occurrences)
  - Why: Primary user documentation must be consistent with new name

- [ ] Update CLAUDE.md project descriptions
  - Files affected: `CLAUDE.md`
  - Change: Replace all "Muleteer" → "Escapement" (10 occurrences)
  - Why: Project instructions should reflect new identity

- [ ] Update skill example output
  - Files affected: `skills/prime-session/SKILL.md`
  - Change: Lines 259-260 - Example output showing project name
  - Why: Skill documentation examples should be accurate

### Priority 3: MEDIUM Infrastructure & Output Messages

- [ ] Update hook output message
  - Files affected: `hooks/archive-session-log.sh`
  - Change: Line 153 - Comment text in output
  - Why: User-visible hook messages should reference correct name

- [ ] Update repository URL references
  - Files affected: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - Change: Repository URL from fusupo/muleteer → fusupo/escapement
  - Why: GitHub repo will be renamed - URLs must match
  - Note: **CONFIRMED** - repo will be renamed on GitHub

### Priority 4: LOW Deprecated Documentation

- [ ] Review and update deprecated paths in CUSTOMIZATION.md
  - Files affected: `docs/CUSTOMIZATION.md`
  - Change: `~/.muleteer/` references (2 occurrences)
  - Why: Consistency in documentation (though these refer to deprecated v1.0)

- [ ] Review and update deprecated paths in WORKFLOW.md
  - Files affected: `docs/WORKFLOW.md`
  - Change: `~/.muleteer/` references (7 occurrences)
  - Why: Consistency in documentation (though these refer to deprecated v1.0)

- [ ] Review and update deprecated paths in SESSION-ARCHIVING.md
  - Files affected: `docs/SESSION-ARCHIVING.md`
  - Change: `~/.muleteer/` references (6 occurrences)
  - Why: Consistency in documentation (though these refer to deprecated v1.0)

### Priority 5: OPTIONAL Archive Files (Historical Records)

- [x] **DECISION: Preserve archive files as-is**
  - Files affected: 230+ occurrences in `/docs/dev/cc-archive/`
  - Change: NONE - preserving historical accuracy
  - Why: Archive files document actual development history with "muleteer" name
  - Note: Skipping this entire priority level per user decision

### Quality Checks
- [ ] Test plugin loads with new name
- [ ] Test skill invocation with `/escapement:*` syntax
- [ ] Verify marketplace.json is valid JSON
- [ ] Check all documentation for broken references
- [ ] Self-review for any missed "muleteer" references

### Documentation
- [ ] Verify README.md renders correctly
- [ ] Verify CLAUDE.md is accurate for new name

## Technical Notes

### Architecture Considerations
- **Plugin namespace change**: Changing `"name"` in plugin.json from "muleteer" to "escapement" changes the skill invocation prefix from `/muleteer:skill-name` to `/escapement:skill-name`
- **User impact**: Users must update their mental model and any documentation referencing the old name
- **Backward compatibility**: No backward compatibility - this is a breaking change for users who have installed v1.x with "muleteer" name

### Implementation Approach
This is a systematic find-and-replace refactoring with priority-based implementation:

1. **Critical first**: Plugin manifest changes to establish new identity
2. **Documentation second**: Update all user-facing docs to match
3. **Infrastructure third**: Update messages and examples
4. **Deprecated last**: Clean up outdated documentation references
5. **Archives optional**: Decide whether to preserve historical accuracy

The rename is straightforward but pervasive - affects 326 references across 24 files. The key is being systematic and not missing any references.

**Why "escapement" vs alternatives:**
- Metaphor: A clock escapement provides measure and control (aligns with issue rationale)
- Less potentially insulting than "muleteer"
- Maintains mechanical/tool metaphor of original name

### Potential Challenges
- **Completeness**: Must catch all references to avoid user confusion
- **GitHub repository**: If the GitHub repo itself is renamed (fusupo/muleteer → fusupo/escapement), all repository URLs need updating
- **User migration**: Existing users will need to update their understanding and any custom workflows
- **Archive files**: Decision needed on whether to update historical records (230+ occurrences)

### Search Strategy
Use case-insensitive search to catch all variations:
```bash
grep -ri "muleteer" . --exclude-dir=.git --exclude-dir=node_modules
```

Replace with context-appropriate capitalization:
- "muleteer" → "escapement" (lowercase, plugin identifier)
- "Muleteer" → "Escapement" (title case, documentation)
- "/muleteer:" → "/escapement:" (skill invocation prefix)

## Questions/Blockers

### Clarifications Needed
- [ ] Should the GitHub repository itself be renamed from fusupo/muleteer to fusupo/escapement?
  - If YES: Update all repository URL references
  - If NO: Keep repository URLs as-is

- [ ] Should historical archive files (230+ occurrences) be updated for consistency or preserved as-is for historical accuracy?
  - If UPDATE: Change all references in `/docs/dev/cc-archive/`
  - If PRESERVE: Leave archive files unchanged, they document actual history

### Blocked By
None - this is a self-contained refactoring task

### Assumptions Made
1. The plugin.json name change is the primary change that defines the new identity
2. All active documentation should reference "Escapement" consistently
3. Deprecated v1.0 documentation can be updated even though those patterns are no longer used
4. The local directory name `/home/marc/muleteer/` does not need to change (it's a local path, not the plugin identifier)

### Decisions Made
**2026-01-02 - Issue Setup**

**Q: Should the GitHub repository itself be renamed from fusupo/muleteer to fusupo/escapement?**
**A:** Yes, rename on GitHub
**Rationale:** Full rename includes repository - all URL references will be updated

**Q: How should historical archive files (230+ occurrences in /docs/dev/cc-archive/) be handled?**
**A:** Preserve as-is
**Rationale:** Archive files document actual historical development - maintain historical accuracy

## Work Log

---
**Generated:** 2026-01-02
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/muleteer/issues/17
**Analysis:** 326 occurrences across 24 files identified by Explore agent
