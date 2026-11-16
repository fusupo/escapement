# Escapement Context Path Extension

## Overview

Extension to Escapement that redirects session logs, scratchpads, and archives to a **sibling context directory** instead of polluting the code repo with development artifacts.

## Problem

Session logs and archives accumulate in `docs/dev/cc-archive/` inside the code repo, causing:
- Search pollution (grep/ripgrep/editor indexing hits log content)
- Repo bloat (session transcripts can be large)
- Noise in code review (archive commits mixed with feature work)

## Solution

A single config line in the project's `CLAUDE.md` tells Escapement to write all development artifacts to a sibling directory:

```markdown
## Escapement Settings

- **context-path**: ../myproject-ctx
```

When set, the skills that write artifacts (archive-work, stash-artifact, the manifest skills) use this path instead of in-repo locations. Session logs from the PreCompact hook still start in the project root, and archive-work moves them. When unset, existing behavior is preserved.

## What Changes

### 1. CLAUDE.md Convention

Projects opt in by adding an `Escapement Settings` section:

```markdown
## Escapement Settings

- **context-path**: ../myproject-ctx
```

The path is relative to the project root. Typical values:
- `../myproject-ctx` (sibling directory, most common)
- `~/dev-context/myproject` (absolute path to shared context location)

#### How the setting is read

Everything that needs the setting reads it with the same rules:
- `scripts/get-context-path.sh` for skills
- `parseContextPath` in `manifest/init.ts`
- `parse_context_path` in `scripts/migrate-archives.py`

The rules are:

- Only the first `## Escapement Settings` section counts. It runs until the next `#` or `##` heading, so `###` subheadings stay inside it.
- Lines inside fenced code blocks (```` ``` ```` or `~~~`) are ignored everywhere. This is what lets a CLAUDE.md show the setting as an example, as this document does, without the example being picked up.
- The setting line is `- **context-path**: <value>`, and `*` bullets also work. The value is the rest of the line with trailing whitespace trimmed and one pair of surrounding quotes or backticks removed, so paths with spaces work.
- A `context-path` line outside the section is ignored, and a warning goes to stderr.
- If there is no setting, the parser prints nothing, and in-repo mode applies.

Skills run the parser like this:

```bash
CONTEXT_PATH=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/get-context-path.sh" CLAUDE.md)
```

The shared cases in `scripts/fixtures/context-path.md` describe the expected behavior, and all three implementations are tested against them:
- `scripts/test-get-context-path.sh`
- `manifest/test-init.ts`
- `scripts/test-migrate-archives.py`

### 2. Context Directory Structure

The context directory uses a flat-on-main, directory-per-branch layout:

```
myproject-ctx/
├── INDEX.md
├── main/
│   ├── notes/
│   └── scripts/
├── 42-add-authentication/
│   ├── archive/
│   │   ├── SCRATCHPAD_42.md
│   │   ├── SESSION_LOG_1.md
│   │   └── README.md
│   ├── scripts/
│   │   └── test-auth-flow.sh
│   └── notes/
│       └── api-design-options.md
├── 43-fix-login-bug/
│   ├── archive/
│   │   ├── SCRATCHPAD_43.md
│   │   └── README.md
│   └── notes/
└── .gitignore
```

Key conventions:
- Top-level directories match code repo branch names
- `archive/` subdirectory replaces `docs/dev/cc-archive/{timestamp}-{issue}/`
- `scripts/` for ad hoc scripts that shouldn't be committed to code repo
- `notes/` for freeform dev notes, research, etc.
- No timestamp prefix on branch directories (the branch name IS the identifier)
- Timestamp stays on archive artifacts if multiple archives per branch

### 3. Hook (archive-session-log.sh)

The hook always writes `SESSION_LOG_{N}.jsonl` to the **project root**, regardless of context-path configuration. This keeps session logs alongside the active scratchpad during work. The `archive-work` skill is responsible for moving session logs to the context directory at archive time. Each log holds only the conversation since the previous log (see [Session Archiving](SESSION-ARCHIVING.md#what-a-session-log-covers)).

### 4. Modified Skill (archive-work)

The archive-work skill gains context-path awareness:
1. Read the `context-path` setting with `scripts/get-context-path.sh` (see [How the setting is read](#how-the-setting-is-read))
2. If set, archive to `{context-path}/{branch}/archive/` instead of `docs/dev/cc-archive/`
3. Scratchpad is copied to context directory, then removed from code repo (`git rm`)
4. Session logs are moved from project root to the archive directory
5. README summary still generated
6. Commit in code repo only removes the scratchpad (clean)
7. Context directory changes are left for the operator to commit/push separately

### 5. INDEX.md Manifest

The `archive-work` skill maintains an `INDEX.md` file at the root of the context directory. Each time work is archived, a row is added to a chronological table:

```
{context-path}/INDEX.md
```

**Format:**

```markdown
# Archive Index

| Archived | Branch | Issue | Status |
|----------|--------|-------|--------|
| 2026-02-25 | 44-refactor-api | [#44](url) Refactor API | Merged |
| 2026-02-20 | 43-fix-login-bug | [#43](url) Fix login bug | Merged |
| 2026-02-13 | 42-add-authentication | [#42](url) Add authentication | Merged |
```

- Rows are newest-first (most recent archive at the top)
- Created automatically on first archive if it doesn't exist
- `Status` matches the archive README: `Merged`, `Completed`, or `Abandoned`
- Renders correctly in both Obsidian and GitHub markdown

The `INDEX.md` file is outside the code repo and not auto-committed. Commit it alongside other context directory changes when desired.

### 6. New Skill (stash-artifact)

A lightweight skill for saving ad hoc scripts and notes to the context directory:

Triggers: "stash this script", "save this to context", "keep this outside the repo"

Behavior:
1. Read context-path with `scripts/get-context-path.sh`
2. Determine current branch
3. Copy/write the artifact to `{context-path}/{branch}/scripts/` or `{context-path}/{branch}/notes/`
4. Report location

## What Doesn't Change

- setup-work: still creates scratchpads in project root (they're active working files)
- do-work: still reads scratchpads from project root
- commit-changes: unchanged
- create-pr: unchanged
- review-pr: unchanged
- prime-session: unchanged (but could learn to read context dir for additional context)

## Backward Compatibility

- No `context-path` in CLAUDE.md -> everything works exactly as before
- Context path set -> only archive-work, stash-artifact and the manifest skills change behavior
- A `context-path` line that is not under `## Escapement Settings` is now ignored, with a warning (#57). Earlier versions accepted it anywhere in CLAUDE.md, including inside code examples
- Existing archives in `docs/dev/cc-archive/` are not migrated automatically

## Obsidian Compatibility

The context directory is plain markdown files in a git repo. If the operator points Obsidian at it, they get:
- Full-text search across all branches' artifacts
- Graph view linking sessions to issues
- Backlinks from notes to scratchpads
- Tags in frontmatter for filtering

This is not an Obsidian plugin. It's just a directory of markdown that Obsidian can consume.

## Future Considerations

- **Branch auto-creation**: setup-work could create the branch directory in context repo automatically
- **Context loading**: prime-session could read recent context from the sibling directory
- **Cross-project context**: multiple projects could share a context root (`~/dev-context/`)
