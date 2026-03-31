# Manifest: PGlite schema setup - #33

## Issue Details
- **Repository:** fusupo/escapement
- **GitHub URL:** https://github.com/fusupo/escapement/issues/33
- **State:** open
- **Labels:** manifest
- **Milestone:** none
- **Assignees:** none
- **Related Issues:**
  - Blocks: #34, #35, #36, #37, #38, #39, #40, #41

## Description

Set up PGlite (PostgreSQL in WASM) with the V2 schema in the Escapement context-path.

## Acceptance Criteria
- [ ] PGlite initializes and creates a data directory at `{context-path}/manifest/pgdata/`
- [ ] `work_items` table matches V2 spec exactly (all columns, CHECK constraints, defaults)
- [ ] `edges` table matches V2 spec exactly (all columns, CHECK constraints, UNIQUE constraint)
- [ ] All 9 indexes created (kind, state, repo, predicted_files GIN, actual_files GIN, edges rel/from/to/confidence)
- [ ] Schema can be applied to a fresh PGlite instance without errors
- [ ] A smoke test inserts a work item + edge and reads them back

## Branch Strategy
- **Base branch:** develop
- **Feature branch:** 33-manifest-system
- **Current branch:** 33-manifest-system

## Implementation Checklist

### Setup
- [x] Initialize Node.js project in `manifest/` directory within the repo
  - `package.json` with `@electric-sql/pglite` dependency
  - `tsconfig.json` for TypeScript
  - Files: `manifest/package.json`, `manifest/tsconfig.json`
  - Why: First TypeScript code in this repo — needs a contained Node setup

### Implementation Tasks

- [x] Create schema SQL file (`manifest/schema.sql`)
  - `work_items` table with all columns and CHECK constraints from V2 Section 7.2
  - `edges` table with all columns, CHECK constraints, and UNIQUE constraint
  - All 9 indexes
  - Files: `manifest/schema.sql`
  - Why: Keeps schema as plain SQL, readable and portable to real Postgres

- [x] Create initialization script (`manifest/init.ts`)
  - Import PGlite, point data dir to `{context-path}/manifest/pgdata/`
  - Read and execute `schema.sql`
  - Export a `getDb()` function for reuse by CLI and other scripts
  - Files: `manifest/init.ts`
  - Why: Single entry point for database setup, reusable by downstream issues

- [x] Create smoke test (`manifest/test-schema.ts`)
  - Initialize PGlite with a temp directory (not the real context-path)
  - Apply schema
  - Insert a phase work item
  - Insert an issue work item with predicted_files
  - Insert a depends_on edge
  - Query back and verify
  - Test UNIQUE constraint on edges (duplicate insert should fail)
  - Test CHECK constraints (invalid kind/state should fail)
  - Files: `manifest/test-schema.ts`
  - Why: Proves schema works before downstream issues build on it

### Quality Checks
- [x] `npx tsc --noEmit` passes
- [x] Smoke test runs successfully (17/17 assertions)
- [x] Schema SQL is valid standalone (could be pasted into any Postgres)

## Technical Notes

### Architecture Considerations
- The `manifest/` directory is new — first TypeScript in this repo
- Keep it self-contained with its own package.json to avoid polluting the plugin root
- PGlite data dir lives in the context-path (`../escapement-ctx/manifest/pgdata/`), not in the repo
- The schema.sql should be a standalone file that works in any Postgres, not just PGlite

### Implementation Approach
- Plain SQL schema file + TypeScript init script that reads it
- PGlite's Node.js API is straightforward: `new PGlite(dataDir)` then `db.exec(sql)`
- Smoke test uses a temp dir so it doesn't touch the real manifest

### Potential Challenges
- PGlite GIN index support for TEXT[] — need to verify `&&` operator works
- PGlite SERIAL type support — should work but verify auto-increment on edges.id
- Context-path resolution — need a reliable way to find it (read from CLAUDE.md or config)

## Questions/Blockers

### Clarifications Needed
None — the schema is fully specified in V2.

### Assumptions Made
- `manifest/` directory within the repo is the right location for this code
- Separate package.json in `manifest/` (not at repo root) to keep the plugin clean
- Context-path (`../escapement-ctx`) is resolved relative to the repo root at runtime

## Work Log

### 2026-03-31 - Implementation Complete
- Created `manifest/` directory with package.json, tsconfig.json
- Installed @electric-sql/pglite, tsx, typescript, @types/node
- Created schema.sql matching V2 spec exactly
- Created init.ts with getDb(), applySchema(), ensureSchema(), initManifest()
- Created test-schema.ts: 17 assertions all passing
  - Tables, inserts, queries, GIN array overlap, UNIQUE/CHECK/FK constraints, defaults
- Type check clean (`npx tsc --noEmit`)
- PGlite GIN indexes work correctly with TEXT[] and && operator
- SERIAL auto-increment works on edges.id

---
**Generated:** 2026-03-31
**By:** Issue Setup Skill
**Source:** https://github.com/fusupo/escapement/issues/33
