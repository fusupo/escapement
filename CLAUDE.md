# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Muleteer is a generic Claude Code workflow system designed to work across multiple projects simultaneously. It provides:
- **Skills**: Automated workflow modules invoked via natural language
- **Agents**: Specialized AI assistants (extensibility ready)
- **Multi-Project Support**: Global installation with per-project customization

## Architecture

Muleteer uses a two-tier architecture:

1. **Global Layer** (~/.muleteer/): The generic workflow base installed once
2. **Per-Project Layer** (each repo's CLAUDE.md): Project-specific conventions

### Directory Structure

```
.muleteer/
├── skills/              # Automated workflow modules
│   ├── issue-setup/     # GitHub issue → scratchpad → branch
│   ├── commit-changes/  # Smart git commits with conventions
│   ├── create-pr/       # Context-aware pull request creation
│   ├── review-pr/       # Roadmap-aware PR review
│   ├── work-session/    # Execute work from scratchpad
│   ├── archive-work/    # Archive completed scratchpads
│   └── prime-session/   # Project orientation (auto-invoke)
├── agents/              # Future: specialized subagents
├── templates/           # Project customization templates
├── docs/                # Extended documentation
│   ├── WORKFLOW.md      # Workflow explanation
│   └── CUSTOMIZATION.md # Customization guide
└── install.sh           # Installation script
```

### How It Works

1. **Installation**: `install.sh` symlinks skills/agents to `~/.claude/`
2. **Global Context**: CLAUDE-MULETEER.md gets appended to `~/.claude/CLAUDE.md`
3. **Project-Specific**: Each project repo has its own CLAUDE.md with custom modules/conventions
4. **Invocation**: Skills activate via natural language or explicit Skill tool

## Key Components

### Skills

**Skills are invoked automatically** based on natural language context or explicitly via the Skill tool. Defined by frontmatter in `skills/{name}/SKILL.md`.

| Skill | Trigger Examples | Purpose |
|-------|-----------------|---------|
| `issue-setup` | "Setup issue #42" | Fetch issue, create scratchpad, prepare branch |
| `commit-changes` | "Commit these changes" | Smart commits with project conventions |
| `create-pr` | "Create a PR" | Context-aware pull request creation |
| `review-pr` | "Review PR #123" | Roadmap-aware code review |
| `work-session` | "Start working on issue #42" | Execute tasks from scratchpad with TodoWrite |
| `archive-work` | "Archive this work" | Move completed scratchpads to archive |
| `prime-session` | Auto or "Orient me" | Read project docs for context |

### Agents

**Agents are specialized subagents** for delegation (extensibility ready). Defined as markdown files in `agents/`.

Currently empty but ready for extension.

## Development Commands

### Installation and Updates

```bash
# Install Muleteer globally
~/.muleteer/install.sh

# Update after making changes
cd ~/.muleteer
git pull
./install.sh
```

### Testing Changes

After modifying skills/agents:

```bash
# Re-run install to update symlinks
./install.sh

# Verify symlinks
ls -la ~/.claude/skills/
ls -la ~/.claude/agents/

# Restart Claude Code to pick up changes
```

### Creating New Skills

1. Create `skills/your-skill-name/SKILL.md`
2. Add frontmatter with name, description, tools
3. Document natural language triggers
4. Run `./install.sh`
5. Test with natural language invocation

**Skill Frontmatter Format:**
```yaml
---
name: skill-name
description: What this skill does and trigger patterns
tools:
  - ToolName
  - Bash:pattern *
  - mcp__github__*
---
```

### Creating New Agents

1. Create `agents/your-agent.md`
2. Define specialized expertise
3. List required tools in frontmatter
4. Run `./install.sh`

## File Patterns and Conventions

### Scratchpad Files

- **Location**: Project root (not in .muleteer repo)
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

Change type emojis are defined in CLAUDE-MULETEER.md. Module emojis are defined per-project in each repo's CLAUDE.md.

## Important Behavior Notes

### Multi-Project Awareness

Muleteer is installed **once globally** but works across **all projects**:
- Skills detect current git repo context
- Read project's CLAUDE.md for conventions
- Apply project-specific module emojis and standards
- Each project maintains independent workflow state

### Skill Invocation

Skills can be invoked two ways:
1. **Natural Language**: "Commit these changes" → `commit-changes` skill
2. **Explicit**: Via Skill tool with skill name

The `prime-session` skill auto-invokes when Claude detects a new/unfamiliar repository.

### Workflow Philosophy

1. **Structured approach**: Issue → Scratchpad → Implementation → PR
2. **Incremental progress**: Atomic commits, reviewable changes
3. **Project awareness**: Adapts to each project's conventions
4. **Quality focus**: Functional correctness over premature optimization

### Never Do

- Don't mix unrelated changes in single commit
- Don't modify project-specific files (each repo's CLAUDE.md) from .muleteer repo
- Don't push directly to main (always PR)
- Don't skip commit message descriptions
- Don't leave debugging code or console.logs

## Project Modules

Since Muleteer is a workflow system (not a traditional codebase), modules are organizational:

- **workflow** 🔄: Core workflow definition and documentation
- **skills** 🎯: Automated workflow skills
- **templates** 📋: Customization templates
- **docs** 📚: Extended documentation
- **install** 🔧: Installation and setup

## Current Development Focus

**Phase**: v2.0.0 (Skill-based architecture)

**Completed**:
- Rearchitected commands as skills
- Natural language invocation
- TodoWrite integration
- Interactive Q&A in issue-setup

**Priorities**:
1. Testing and validation across projects
2. Documentation updates
3. Claude Code affordances integration
4. Multi-project compatibility

**Future Extensibility**:
- Custom agents for specialized tasks
- Project templates for common stacks
- Workflow hooks and context archiving

## Testing Standards

Testing happens through actual usage across projects:
- Test changes by re-running `install.sh`
- Verify skills work via natural language
- Ensure backward compatibility with existing project CLAUDE.md files
- Validate symlinks are created correctly

## Contributing Guidelines

When modifying Muleteer:

1. **Test thoroughly**: Use `install.sh` and test in multiple projects
2. **Preserve compatibility**: Don't break existing project CLAUDE.md files
3. **Document changes**: Update relevant docs/ files
4. **Follow patterns**: Use established skill structure
5. **Keep it generic**: This is a multi-project system, avoid project-specific assumptions

## Critical Implementation Details

### Installation Script Behavior

`install.sh` performs:
- Creates `~/.claude/{agents,skills}` directories
- Symlinks all skills/agents to `~/.claude/`
- Cleans up old command symlinks (from previous versions)
- Appends CLAUDE-MULETEER.md to `~/.claude/CLAUDE.md` (once)
- Removes existing symlinks before creating new ones
- Idempotent: Safe to run multiple times

### Skill Frontmatter Format

Required fields:
```yaml
---
name: skill-name
description: What this skill does and natural language triggers
tools:
  - ToolName
  - Bash:pattern *
---
```

The `description` field should include natural language trigger patterns so Claude knows when to invoke the skill.

## Key File References

- `README.md`: User-facing overview and installation
- `CLAUDE-MULETEER.md`: Global context appended to `~/.claude/CLAUDE.md`
- `docs/WORKFLOW.md`: Detailed workflow explanation
- `docs/CUSTOMIZATION.md`: Guide for per-project customization
- `templates/CLAUDE-MULETEER.template.md`: Template for project CLAUDE.md files
