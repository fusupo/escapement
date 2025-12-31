# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muleteer is a Claude Code plugin that provides reusable workflow modules for structured development. It works across multiple projects simultaneously and provides:
- **Skills**: Automated workflow modules invoked via natural language or `/muleteer:skill-name`
- **Hooks**: Session archiving on compaction
- **Agents**: Specialized AI assistants (extensibility ready)
- **Multi-Project Support**: One plugin installation, per-project customization

## Architecture

Muleteer is a Claude Code plugin with the following structure:

### Directory Structure

```
muleteer/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest (name, version, author)
├── skills/              # Automated workflow modules
│   ├── issue-setup/     # GitHub issue -> scratchpad -> branch
│   ├── commit-changes/  # Smart git commits with conventions
│   ├── create-pr/       # Context-aware pull request creation
│   ├── review-pr/       # Roadmap-aware PR review
│   ├── work-session/    # Execute work from scratchpad
│   ├── archive-work/    # Archive completed scratchpads
│   └── prime-session/   # Project orientation
├── hooks/
│   ├── hooks.json       # Hook configuration
│   └── archive-session-log.sh  # PreCompact hook script
├── agents/              # Future: specialized subagents
├── docs/                # Extended documentation
│   ├── WORKFLOW.md      # Workflow explanation
│   └── CUSTOMIZATION.md # Customization guide
└── README.md            # User-facing documentation
```

### How It Works

1. **Plugin Loading**: `claude --plugin-dir /path/to/muleteer` or marketplace install
2. **Skill Invocation**: Natural language or `/muleteer:skill-name`
3. **Hooks**: Automatically registered from `hooks/hooks.json`
4. **Per-Project**: Each project repo has its own CLAUDE.md with custom modules/conventions

## Key Components

### Skills

**Skills are invoked automatically** based on natural language context or explicitly via `/muleteer:skill-name`. Defined by frontmatter in `skills/{name}/SKILL.md`.

| Skill | Trigger Examples | Purpose |
|-------|-----------------|---------|
| `issue-setup` | "Setup issue #42" | Fetch issue, create scratchpad, prepare branch |
| `commit-changes` | "Commit these changes" | Smart commits with project conventions |
| `create-pr` | "Create a PR" | Context-aware pull request creation |
| `review-pr` | "Review PR #123" | Roadmap-aware code review |
| `work-session` | "Start working on issue #42" | Execute tasks from scratchpad with TodoWrite |
| `archive-work` | "Archive this work" | Move completed scratchpads to archive |
| `prime-session` | "Orient me", "What is this project" | Read project docs for context |

### Hooks

**PreCompact hook** archives session transcripts before auto-compaction:
- Configured in `hooks/hooks.json`
- Uses `${CLAUDE_PLUGIN_ROOT}` for portable paths
- Creates `SESSION_LOG_{N}.md` files in project root
- Requires `jq` to be installed

### Agents

**Agents are specialized subagents** for delegation (extensibility ready). Defined as markdown files in `agents/`.

Currently empty but ready for extension.

## Development Commands

### Testing Plugin

```bash
# Run Claude Code with the plugin
claude --plugin-dir /path/to/muleteer

# Verify plugin loads
/help  # Should show muleteer skills
```

### Creating New Skills

1. Create `skills/your-skill-name/SKILL.md`
2. Add frontmatter with name, description, tools
3. Document natural language triggers in description
4. Test with `claude --plugin-dir .`
5. Commit and push

**Skill Frontmatter Format:**
```yaml
---
name: skill-name
description: What this skill does. Invoke when user says "trigger phrase".
tools:
  - mcp__github__*
  - Read
  - Write
  - Bash:git *
---
```

### Creating New Agents

1. Create `agents/your-agent.md`
2. Define specialized expertise
3. List required tools in frontmatter
4. Test with `claude --plugin-dir .`

### Modifying Hooks

Edit `hooks/hooks.json` following Claude Code hooks documentation. Use `${CLAUDE_PLUGIN_ROOT}` for paths to ensure portability.

## File Patterns and Conventions

### Scratchpad Files

- **Location**: Project root (created in user's project, not in muleteer)
- **Format**: `SCRATCHPAD_{issue_number}.md`
- **Created by**: `issue-setup` skill
- **Purpose**: Implementation plan and progress tracking
- **Sync**: TodoWrite shows live progress, scratchpad is persistent record

### Project CLAUDE.md

Each project repo should have its own CLAUDE.md defining:
- Project modules with emojis
- Architecture overview
- Development priorities
- Branch naming conventions
- Testing standards

### Commit Message Format

Default format (customizable per project):
```
{module emoji}{change type emoji} {type}({scope}): {description}

{optional body explaining what and why}
```

Module emojis are defined per-project in each repo's CLAUDE.md.

## Important Behavior Notes

### Multi-Project Awareness

Muleteer is loaded **once as a plugin** but works across **all projects**:
- Skills detect current git repo context
- Read project's CLAUDE.md for conventions
- Apply project-specific module emojis and standards
- Each project maintains independent workflow state

### Skill Invocation

Skills can be invoked two ways:
1. **Natural Language**: "Commit these changes" -> `commit-changes` skill
2. **Explicit**: `/muleteer:commit-changes`

### Workflow Philosophy

1. **Structured approach**: Issue -> Scratchpad -> Implementation -> PR
2. **Incremental progress**: Atomic commits, reviewable changes
3. **Project awareness**: Adapts to each project's conventions
4. **Quality focus**: Functional correctness over premature optimization

### Never Do

- Don't mix unrelated changes in single commit
- Don't modify project-specific files (each repo's CLAUDE.md) from muleteer repo
- Don't push directly to main (always PR)
- Don't skip commit message descriptions
- Don't leave debugging code or console.logs

## Project Modules

Since Muleteer is a plugin (not a traditional codebase), modules are organizational:

- **plugin** 🔌: Plugin manifest and configuration
- **skills** 🎯: Automated workflow skills
- **hooks** 🪝: Event hooks and scripts
- **docs** 📚: Extended documentation

## Current Development Focus

**Phase**: v2.0.0 (Plugin architecture)

**Completed**:
- Converted to Claude Code plugin architecture
- Moved hooks to `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}`
- Updated skill tool specifications
- Removed install.sh/uninstall.sh

**Priorities**:
1. Testing plugin across projects
2. Marketplace distribution
3. Claude Code affordances integration

**Future Extensibility**:
- Custom agents for specialized tasks
- Project templates for common stacks
- Additional hooks for workflow automation

## Testing Standards

Testing happens through actual usage:
- Test changes with `claude --plugin-dir .`
- Verify skills work via natural language and explicit invocation
- Ensure hooks trigger correctly
- Validate plugin loads without errors

## Contributing Guidelines

When modifying Muleteer:

1. **Test thoroughly**: Use `claude --plugin-dir .` and test in multiple projects
2. **Preserve compatibility**: Don't break existing project CLAUDE.md files
3. **Document changes**: Update README.md and relevant docs
4. **Follow patterns**: Use established skill structure
5. **Keep it generic**: This is a multi-project system, avoid project-specific assumptions

## Critical Implementation Details

### Plugin Manifest

`.claude-plugin/plugin.json` defines:
- `name`: Plugin identifier and namespace prefix
- `version`: Semantic versioning
- `description`: Plugin purpose
- `author`: Attribution

### Skill Frontmatter Format

Required fields:
```yaml
---
name: skill-name
description: What this skill does. Invoke when user says "trigger phrase".
tools:
  - mcp__github__*
  - Read
  - Write
  - Bash:git *
---
```

The `description` field should include natural language trigger patterns so Claude knows when to invoke the skill.

### Hook Configuration

`hooks/hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` for portable paths:
```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [{
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/hooks/archive-session-log.sh"
        }]
      }
    ]
  }
}
```

## Key File References

- `README.md`: User-facing overview and installation
- `.claude-plugin/plugin.json`: Plugin manifest
- `hooks/hooks.json`: Hook configuration
- `docs/WORKFLOW.md`: Detailed workflow explanation
- `docs/CUSTOMIZATION.md`: Guide for per-project customization
