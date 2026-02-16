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

When set, all skills that write artifacts (archive-work, session logs via hook) use this path instead of in-repo locations. When unset, existing behavior is preserved.

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

### 2. Context Directory Structure

The context directory uses a flat-on-main, directory-per-branch layout:

```
myproject-ctx/
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

### 3. Modified Hook (archive-session-log.sh)

The hook script gains context-path awareness:
1. Check if `CLAUDE.md` contains `context-path` setting
2. If set, resolve the path and write `SESSION_LOG_{N}.md` there (under the current branch directory)
3. If not set, fall back to current behavior (write to project root)

### 4. Modified Skill (archive-work)

The archive-work skill gains context-path awareness:
1. Read `CLAUDE.md` for `context-path` setting
2. If set, archive to `{context-path}/{branch}/archive/` instead of `docs/dev/cc-archive/`
3. Scratchpad is copied to context directory, then removed from code repo (`git rm`)
4. Session logs are moved from wherever they landed (project root or context dir)
5. README summary still generated
6. Commit in code repo only removes the scratchpad (clean)
7. Context directory changes are left for the operator to commit/push separately

### 5. New Skill (stash-artifact)

A lightweight skill for saving ad hoc scripts and notes to the context directory:

Triggers: "stash this script", "save this to context", "keep this outside the repo"

Behavior:
1. Read context-path from CLAUDE.md
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
- Context path set -> only archive-work and the hook change behavior
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
