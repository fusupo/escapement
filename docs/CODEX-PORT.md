# Codex Sibling Repo Plan (Escapement -> Codex)

This document describes, in exhaustive detail, how to reimplement the Escapement workflow system for Codex CLI. It is written to be handed to any engineer to recreate the system without needing prior analysis.

## 0) Purpose and scope

Escapement today is a Claude Code plugin that provides:
- A regulated issue -> plan -> implement -> review -> archive workflow
- A suite of skills that automate common steps
- A pre-compaction hook that archives session logs
- A scratchpad planning artifact per issue
- Optional subagent logic (scratchpad-planner)

The Codex sibling repo should preserve the workflow semantics while replacing Claude-specific mechanisms (plugin, hooks, /commands, subagents) with Codex-native mechanisms (AGENTS.md instructions and Codex skills installed under $CODEX_HOME/skills).

This document defines:
- A target repo structure
- Codex-specific equivalents for each Escapement feature
- Detailed instructions for authoring the Codex skills
- Templates for AGENTS.md and scratchpad files
- A migration checklist and verification steps

## 1) Differences between Claude Code and Codex CLI

### Claude Code (current)
- Plugin manifest (.claude-plugin/plugin.json)
- Skill invocation via /escapement:skill-name or implicit
- Hooks, including PreCompact
- Subagents (scratchpad-planner)

### Codex CLI (target)
- AGENTS.md instructions drive agent behavior
- Skills are locally installed in $CODEX_HOME/skills
- No plugin manifest
- No Claude-style hooks; no PreCompact
- No subagent system; use skills or structured prompts instead

### Implications
- Replace plugin install with skill install instructions
- Move behavioral rules into AGENTS.md
- Replace hooks with a manual "archive-session" skill
- Fold subagent planning into a "plan-work" or "setup-work" skill

## 2) Target repository structure

Create a sibling repo with a similar overall layout but Codex-native mechanics:

```
codex-escapement/
├── AGENTS.md
├── README.md
├── docs/
│   ├── WORKFLOW.md
│   ├── CUSTOMIZATION.md
│   ├── SESSION-ARCHIVING.md
│   └── CODEX-PORT.md
├── skills/
│   ├── setup-work/
│   │   └── SKILL.md
│   ├── plan-work/
│   │   └── SKILL.md
│   ├── do-work/
│   │   └── SKILL.md
│   ├── commit-changes/
│   │   └── SKILL.md
│   ├── create-pr/
│   │   └── SKILL.md
│   ├── review-pr/
│   │   └── SKILL.md
│   └── archive-work/
│       └── SKILL.md
├── templates/
│   ├── AGENTS.project.md
│   ├── SCRATCHPAD.md
│   └── SESSION_LOG.md
└── scripts/
    └── archive-session-log.sh
```

Notes:
- The `plan-work` skill is a Codex-native replacement for the Claude subagent scratchpad-planner. You can merge this into `setup-work` if you want fewer skills, but splitting keeps roles clear.
- `templates/` is optional but recommended to avoid large inline text in skill files.

## 3) AGENTS.md (Codex behavioral rules)

AGENTS.md is the equivalent of CLAUDE.md for Codex. It should define:
- Project overview and architecture
- Module definitions and commit emoji conventions
- Branch strategy
- Testing standards
- Workflow rules (issue -> scratchpad -> work -> PR -> archive)

### AGENTS.md template (global/system repo)

```
# Codex Escapement

## Project Overview
Codex-native workflow system that standardizes issue setup, planning, implementation, review, and archival.

## Workflow Philosophy
- Issue -> Scratchpad -> Implement -> Review -> Archive
- Atomic commits only
- No direct pushes to main
- Scratchpad is the source of truth for execution

## Project Modules
- **skills** 🎯: Codex skills and workflows
- **docs** 📚: User documentation and guides
- **scripts** 🪝: Helper scripts
- **templates** 📄: Scratchpad/session templates

## Commit Format
{module emoji}{change type emoji} {type}({scope}): {description}

## Branch Strategy
- Main branch: main
- Feature branches: {issue_number}-{slugified-title}

## Testing Standards
- No tests in this repo by default; if scripts are added, provide unit tests or smoke tests
```

### Per-project AGENTS.md template (for user projects)

Provide a template in `templates/AGENTS.project.md` with the module list, branch strategy, and commit format. This replaces the CLAUDE.md project template in the current repo.

## 4) Skill design guidelines for Codex

### General constraints
- Use only Codex-available tools: Read, Write, Glob, Grep, Bash, Task, and GitHub MCP tools when applicable.
- Avoid Claude-specific tools (AskUserQuestion, TodoWrite, plugin commands).
- For interaction, write plain questions in the skill instructions and wait for the user.

### Common structure for SKILL.md

```
---
name: skill-name
description: When to invoke this skill in natural language.
tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash:git *
  - mcp__github__*
---

# Skill Name

## Purpose

## Inputs

## Workflow

## Outputs
```

### Data artifacts
- `SCRATCHPAD_{issue_number}.md` in the project root
- `SESSION_LOG_{N}.md` in the project root (optional)
- Archive folder in `docs/dev/codex-archive/{YYYYMMDDHHMM}-{issue-number}-{description}/`

## 5) Mapping Escapement skills to Codex

### 5.1 setup-work (issue intake)

Purpose: fetch issue details, create branch, generate scratchpad, and initialize workflow state.

Key steps:
1. Read project AGENTS.md for conventions.
2. Determine repo owner/name from git remote.
3. Fetch issue from GitHub (if input is #number or URL).
4. Summarize requirements and acceptance criteria.
5. Generate branch name from issue title.
6. Create scratchpad from template.
7. Create and checkout feature branch (after confirmation).

Codex-specific changes:
- Replace AskUserQuestion with explicit "Confirm (yes/no)" prompts.
- Avoid automatic branch change without confirmation.

### 5.2 plan-work (scratchpad planning)

Purpose: deep analysis and generation of an atomic task plan.

Key steps:
1. Read AGENTS.md and relevant project docs.
2. Run repo searches to locate relevant modules.
3. Identify integration points and dependencies.
4. Produce atomic tasks in scratchpad.
5. List open questions and assumptions.

Codex-specific changes:
- This replaces the Claude subagent.
- Use Grep/rg and Read for analysis.

### 5.3 do-work (task execution loop)

Purpose: execute tasks in scratchpad order.

Key steps:
1. Load SCRATCHPAD_{issue_number}.md
2. Identify next unchecked item.
3. Implement in code.
4. Mark scratchpad item complete.
5. Suggest running tests if applicable.

Codex-specific changes:
- No TodoWrite; scratchpad checkboxes are the progress tracker.

### 5.4 commit-changes (atomic commits)

Purpose: craft conventional commits with module emojis.

Key steps:
1. Read AGENTS.md for module list and commit format.
2. Inspect git status and diff.
3. If multiple logical changes, ask for split/selection.
4. Propose commit message and confirm.
5. Run git commit after confirmation.

### 5.5 create-pr (PR automation)

Purpose: open a PR with a structured description.

Key steps:
1. Read SCRATCHPAD and git log for summary.
2. Identify linked issue from branch name.
3. Build PR body with summary, checklist, testing.
4. Ask for confirmation then call GitHub MCP to create PR.

### 5.6 review-pr (review workflow)

Purpose: analyze PR and provide review aligned with roadmap context.

Key steps:
1. Fetch PR diff and metadata.
2. Identify risk areas, regressions, missing tests.
3. Provide review summary with severity ordering.
4. If requested, submit review via GitHub MCP.

### 5.7 archive-work (closeout)

Purpose: move scratchpad and session logs into an archive folder.

Key steps:
1. Create `docs/dev/codex-archive/{timestamp}-{issue-number}-{slug}`
2. Move SCRATCHPAD and SESSION_LOG files into it
3. Write README.md summary
4. Commit archive (optional)

Codex-specific changes:
- Because there is no PreCompact hook, this skill becomes the primary mechanism to preserve context.

## 6) Hook replacement: session archiving for Codex

### Problem
Claude Code uses PreCompact to snapshot the conversation. Codex does not have this hook.

### Solution
Provide an explicit skill + optional script to append a session log:

Option A (no script):
- `archive-session` skill that asks for a summary and writes it to `SESSION_LOG_{N}.md`.
- The assistant includes:
  - metadata (date, branch, issue)
  - summary of work
  - decisions and assumptions

Option B (script-assisted):
- Keep a simple `scripts/archive-session-log.sh` that appends from a passed block of text.
- Skill calls the script with Bash, passing metadata and summary.

Recommendation:
- Start with Option A (pure skill) to avoid shell dependencies.

## 7) Scratchpad structure and templates

### Scratchpad template (templates/SCRATCHPAD.md)

```
# {Issue Title} - #{issue_number}

## Issue Details
- **Repository:** {owner/repo}
- **GitHub URL:** {issue_url}
- **State:** {open/closed}
- **Labels:** {labels}
- **Milestone:** {milestone}
- **Assignees:** {assignees}
- **Related Issues:**
  - Depends on: {list}
  - Blocks: {list}
  - Related: {list}

## Description
{issue body}

## Acceptance Criteria
- [ ] ...

## Branch Strategy
- **Base branch:** main
- **Feature branch:** {issue_number}-{slugified-title}
- **Current branch:** {current branch}

## Implementation Checklist

### Setup
- [ ] Fetch latest from base branch
- [ ] Create and checkout feature branch

### Tasks
- [ ] ...
- [ ] ...

## Notes
- ...

## Questions / Blockers
- ...
```

## 8) README updates for Codex

The README should be rewritten to:
- Explain this is a Codex workflow system (not a Claude plugin)
- Describe installing skills into $CODEX_HOME/skills
- Show how to reference skills in natural language
- Provide a minimal quickstart: copy AGENTS.md into project and run setup-work

Example README sections:
- What this is
- How to install skills
- How to use
- Workflow overview
- How to customize per project
- How to archive work

## 9) Migration checklist (Claude -> Codex)

1. Remove Claude plugin files:
   - `.claude-plugin/plugin.json`
2. Replace CLAUDE.md with AGENTS.md instructions
3. Rewrite README to reference Codex
4. Update docs:
   - WORKFLOW.md: replace /commands with skill usage
   - CUSTOMIZATION.md: replace CLAUDE.md with AGENTS.md
   - SESSION-ARCHIVING.md: remove PreCompact, add manual skill flow
5. Refactor skills:
   - Remove Claude-only tools
   - Convert AskUserQuestion to explicit prompts
   - Replace subagent use with plan-work skill
6. Add templates for AGENTS and SCRATCHPAD
7. Add archive-work / archive-session skill

## 10) Verification steps

- Run Codex in a sample repo with AGENTS.md present
- Ask: "setup issue #X" (ensure scratchpad is created)
- Ask: "plan this issue" (ensure scratchpad tasks are generated)
- Ask: "commit these changes" (ensure commit message format)
- Ask: "create a PR" (ensure PR created via MCP)
- Ask: "archive this work" (ensure scratchpad and session logs moved)

## 11) Detailed skill drafting notes

### setup-work drafting notes
- Input parsing: accept `#number`, full URL, or `owner/repo#number`
- Use git remote to derive owner/repo when unspecified
- Ensure scratchpad does not already exist; if it does, redirect to do-work
- Ask for confirmation before creating a new branch

### plan-work drafting notes
- Provide explicit, atomic tasks (1-2 hours each)
- If any task seems too large, split it
- Always list open questions and assumptions
- Tie tasks to modules defined in AGENTS.md

### do-work drafting notes
- Always reference the scratchpad
- Avoid modifying unrelated files
- Update scratchpad with progress notes

### commit-changes drafting notes
- Map modules to emojis from AGENTS.md
- Select conventional commit type
- Ask for confirmation before running git commit

### create-pr drafting notes
- PR body should include:
  - Summary
  - Checklist
  - Testing
  - Notes/risks
- Ask for confirmation before creating PR

### review-pr drafting notes
- Identify:
  - Regressions
  - Edge cases
  - Missing tests
  - Unclear requirements
- If no issues, explicitly state "No blocking issues found"

### archive-work drafting notes
- Include scratchpad, session logs, and short README summary
- Always ask before deleting or moving files

## 12) Optional enhancements

- Add a `release-notes` skill to generate changelog notes from commits
- Add a `status-report` skill that summarizes current scratchpad and open questions
- Add a `quality-check` skill that runs tests and linting

## 13) Open questions for the implementer

- Should Codex skills live in this repo or be installed from a centralized repo?
- Should `plan-work` be merged into `setup-work` to reduce skill count?
- Should `archive-work` auto-commit archive artifacts or ask each time?
- Do we want to keep the emoji convention in Codex or allow plain commits?

