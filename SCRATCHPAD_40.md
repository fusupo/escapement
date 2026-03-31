# Manifest: manifest-check skill - #40

## Issue Details
- **Repository:** fusupo/escapement
- **GitHub URL:** https://github.com/fusupo/escapement/issues/40
- **State:** open
- **Labels:** manifest
- **Milestone:** None
- **Assignees:** None
- **Related Issues:**
  - Depends on: #37 (manifest-bootstrap skill)
  - Related: #33 (PGlite schema), #34 (core SQL queries), #35 (CLI wrapper), #36 (self-seed)

## Description

Build the `manifest-check` skill for ad-hoc recheck: reconcile predictions vs actuals, ingest new issues, re-run overlap analysis, and surface drift.

## Acceptance Criteria

- [ ] `skills/manifest-check/SKILL.md` exists with proper frontmatter
- [ ] Skill identifies stale `in_progress` items (no branch activity)
- [ ] Skill reconciles predicted vs actual files for completed items
- [ ] Skill ingests newly filed issues into the manifest
- [ ] Skill re-runs file overlap analysis across current frontier
- [ ] Repeated drift patterns recorded in `meta` for future conservatism
- [ ] Skill prepares additional GitHub write-back payloads if needed

## Branch Strategy
- **Base branch:** 37-manifest-bootstrap-skill (dependency branch, not yet on main)
- **Feature branch:** 40-manifest-check-skill
- **Current branch:** 33-manifest-system

## Implementation Checklist

### Setup
- [x] Fetch latest from base branch
- [x] Create and checkout feature branch from `37-manifest-bootstrap-skill`

### Implementation Tasks

- [x] **Create `skills/manifest-check/SKILL.md` with frontmatter and full skill body**
  - Files affected: `skills/manifest-check/SKILL.md`
  - Why: Core deliverable -- defines the skill's behavior, triggers, tools, and workflow

- [x] **Add `check` subcommand to `manifest/manifest-cli.ts`**
  - Files affected: `manifest/manifest-cli.ts`
  - Why: The skill needs CLI support for stale detection, reconciliation, overlap re-run, and drift recording. Keeping logic in the CLI keeps skills declarative.

- [x] **Add supersession detection query to `manifest/queries/`**
  - Files affected: `manifest/queries/superseded.sql`
  - Why: Identify `in_progress` items that may be superseded by newer items with overlapping predicted files or scope; query used by CLI `check` subcommand

- [x] **Add reconciliation query to `manifest/queries/`**
  - Files affected: `manifest/queries/reconcile.sql`
  - Why: Compare `predicted_files` vs `actual_files` for `done` items to measure prediction accuracy

- [x] **Add drift recording logic in CLI check command**
  - Files affected: `manifest/manifest-cli.ts`
  - Why: Repeated drift in the same files should be recorded in `meta` so future planning is more conservative (per Section 13.4)

- [x] **Add tests for check subcommand**
  - Files affected: `manifest/test-check.ts`
  - Why: Verify stale detection, reconciliation, overlap re-run, and drift recording work correctly

### Quality Checks
- [x] Verify skill loads via `claude --plugin-dir .`
- [x] Run manifest CLI tests: `node --import tsx manifest/test-check.ts`
- [x] Verify frontier/overlap queries produce correct results after check
- [x] Self-review for code quality

### Documentation
- [x] Update CLI usage/help text with `check` subcommand
- [x] Ensure skill description includes natural language triggers

## Technical Notes

### Architecture Considerations

The manifest-check skill follows the same pattern as manifest-bootstrap:
- **Skill = declarative orchestration** (SKILL.md describes workflow, invokes CLI)
- **CLI = executable logic** (TypeScript in `manifest/manifest-cli.ts`)
- **Queries = SQL files** in `manifest/queries/`
- **Database = PGlite** at `{context-path}/manifest/pgdata/`

The skill does NOT modify the schema. It operates on the existing `work_items` and `edges` tables.

### Implementation Approach

**Stale detection:** Query `in_progress` items in the current repo. Instead of a time-based threshold, detect supersession: compare each in_progress item's scope and predicted file set against newer planned/in_progress items. If a newer item covers the same files or references the same scope, flag the older item as potentially superseded. Present findings to the user for confirmation before changing state.

**Reconciliation:** For `done` items that have both `predicted_files` and `actual_files`, compute intersection/diff to measure prediction accuracy. Store drift stats in `meta.reconciliation`.

**Issue ingestion:** Fetch open issues from GitHub, compare against existing `work_items` by `issue_number`, insert any new ones with full prediction -- same codebase analysis as bootstrap (predicted files, dependency inference, edge creation).

**Overlap re-run:** Re-execute the existing `manifest/queries/overlap.sql` query against the current frontier, display results.

**Drift recording:** When the same files appear repeatedly in prediction misses, record in `meta.drift_patterns` on affected items. This informs future `manifest-bootstrap` runs to be more conservative.

**Write-back payloads:** Optionally prepare GitHub issue comments with reconciliation results, similar to bootstrap's write-back pattern.

### Potential Challenges
- Supersession detection is semantic -- file overlap is a strong signal but may not capture all cases; need good UX for user confirmation
- Issue ingestion with full prediction requires codebase analysis, which needs the target repo to be cloned locally
- Drift pattern detection requires enough history of completed items to be meaningful

## Questions/Blockers

### Clarifications Needed
(All resolved -- see Decisions Made below)

### Blocked By
- #37 (manifest-bootstrap skill) must be complete -- branch `37-manifest-bootstrap-skill` exists with implementation but not yet merged to main

### Assumptions Made
- The skill will be built on top of branch `37-manifest-bootstrap-skill` since it depends on that infrastructure
- The existing `overlap.sql` query is reusable as-is for the re-run step

### Decisions Made
2026-03-31

**Q: Should stale detection work only for the current repo, or across all repos?**
**A:** Current repo only.
**Rationale:** Simpler implementation; only checks branches in the local git repo.

**Q: What threshold defines "stale"?**
**A:** Not a fixed day count. The skill should determine if later issues supersede earlier ones rather than relying on a time-based threshold.
**Rationale:** Time-based staleness is too simplistic. Semantic supersession (a newer issue covers the same scope) is more meaningful. The skill should compare issue scopes and predicted file sets to detect when a newer item effectively replaces an older in_progress one.

**Q: For newly discovered issues, should the skill attempt file prediction?**
**A:** Full prediction -- same analysis as bootstrap.
**Rationale:** Ensures new issues are fully integrated into the manifest with predicted file sets, enabling overlap analysis immediately.

## Work Log

### 2026-03-31 - Session
- Implemented all 6 tasks for manifest-check skill
- Created `skills/manifest-check/SKILL.md` with full 7-phase workflow
- Added `manifest/queries/superseded.sql` for supersession detection (file overlap + scope_hint match)
- Added `manifest/queries/reconcile.sql` for predicted vs actual file comparison
- Added `check` subcommand to `manifest/manifest-cli.ts` with 5 sub-subcommands: superseded, reconcile, overlap, drift, new-issues
- Running `check` with no subcommand runs all checks in sequence
- Drift recording stores patterns in `meta.drift_patterns` on affected items
- Reconciliation stores results in `meta.reconciliation` on each done item
- Created `manifest/test-check.ts` with 28 assertions covering all check features
- All tests pass, existing CLI tests unaffected

---
**Generated:** 2026-03-31
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/escapement/issues/40
