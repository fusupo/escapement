# Issue #21 - Add create-issue Skill for GitHub/Linear Issue Creation

**Archived:** 2026-02-18
**PR:** #22 (Merged)
**Status:** Completed

## Summary

Added a new `create-issue` skill to Escapement for ad hoc GitHub issue creation from natural language prompts within a Claude Code session. Designed for mid-flow idea capture without breaking stride.

## Key Decisions

1. **Linear scope** -> GitHub only for v1. Linear support deferred to follow-up issue.
2. **Future Linear detection** -> When added, default GitHub with "Create on Linear instead" option.
3. **Usage context** -> Ad hoc, mid-flow tool. Not a ceremony. Designed for capturing ideas without breaking stride.
4. **Clarifying questions emphasis** -> Core interaction is conversational refinement. Ask enough to make a good issue, don't over-interrogate.

## Files Changed

- `skills/create-issue/SKILL.md` (new) - Skill definition with 4-phase workflow
- `README.md` - Added skill to Available Skills table, Structure tree, version bump to 3.4.0
- `CLAUDE.md` - Added skill to Skills table and Directory Structure
- `.claude-plugin/plugin.json` - Version bump to 3.4.0

## Commits

- `0be67d6` feat(skills): Add create-issue skill for ad hoc GitHub issue creation
- `85c89f2` docs(skills): Document create-issue skill in README and CLAUDE.md
- `47a949c` chore(plugin): Bump version to 3.4.0
