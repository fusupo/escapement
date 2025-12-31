# Muleteer

**Generic Claude Code workflow system.** You're the mule, I'm driving you.

## What This Is

Muleteer provides reusable workflow modules for Claude Code to streamline your development process across any project:

- **Skills**: Automated workflow modules (like `issue-setup`)
- **Commands**: Quick workflow helpers for common tasks
- **Agents**: Specialized AI assistants (future extensibility)
- **Multi-Project Support**: Works across all your repos simultaneously

## Workflow Diagram

![Muleteer Workflow](/workflow.png "Development workflow from idea to merge")

## Installation

```bash
# Clone to your home directory
git clone <your-repo-url> ~/.muleteer

# Run install script
~/.muleteer/install.sh
```

This symlinks the workflow into your `~/.claude/` directory, making it available in all projects.

## Updating

```bash
cd ~/.muleteer
git pull
./install.sh
```

## Uninstalling

To cleanly remove Muleteer from your system:

```bash
# Preview what would be removed (recommended first step)
~/.muleteer/uninstall.sh --dry-run

# Uninstall with confirmation prompt
~/.muleteer/uninstall.sh

# Uninstall without confirmation
~/.muleteer/uninstall.sh --force

# Uninstall and clean up empty directories
~/.muleteer/uninstall.sh --force --cleanup
```

This removes:
- Muleteer skill symlinks from `~/.claude/skills/`
- Muleteer agent symlinks from `~/.claude/agents/`
- Muleteer context section from `~/.claude/CLAUDE.md`
- PreCompact hook from `~/.claude/settings.json`

**Note:** The `~/.muleteer` directory itself is not removed. To completely remove Muleteer:
```bash
rm -rf ~/.muleteer
```

## Usage

### Skills

Skills are invoked automatically by Claude Code when relevant, or you can reference them explicitly:

**Example: Issue Setup Skill**
```bash
# In any repo with Claude Code:
"Setup GitHub issue #42"
# Claude will use the issue-setup skill automatically
```

The skill handles:
- Fetching complete GitHub issue details
- Analyzing requirements and codebase
- Creating structured scratchpad with implementation plan
- Preparing feature branch

### Commands

Commands are slash-commands available in Claude Code:

```bash
/prime-session    # Orient to current project
/commit           # Create conventional commits with emojis
/pr-review        # Structured PR review
/start-work       # Begin work from scratchpad
/open-pr          # Create pull request
/archive-dev      # Archive completed work
```

### Agents

Specialized subagents for delegation (extensibility ready):

```bash
# Future: Custom agents for your workflow
"Use the code-reviewer agent to analyze this module"
```

## Structure

```
.muleteer/
├── skills/
│   └── issue-setup/           # GitHub issue → scratchpad workflow
│       └── SKILL.md
├── commands/                  # Quick workflow helpers
│   ├── prime-session.md       # Session orientation
│   ├── commit.md              # Conventional commits
│   ├── pr-review.md           # PR review workflow
│   ├── start-work.md          # Begin work from scratchpad
│   ├── open-pr.md             # Create pull request
│   └── archive-dev.md         # Archive work
├── agents/                    # Future: Specialized subagents
├── templates/                 # Project customization templates
├── docs/                      # Extended documentation
│   ├── WORKFLOW.md            # Workflow explanation
│   └── CUSTOMIZATION.md       # How to customize
├── install.sh                 # Installation script
├── uninstall.sh               # Uninstallation script
├── workflow.png               # Workflow diagram
└── README.md                  # This file
```

## Philosophy

**Muleteer workflow principles:**

1. **Structured approach** - Clear workflow from issue to merge
2. **Incremental progress** - Atomic commits, reviewable changes
3. **Project awareness** - Adapts to each project's conventions
4. **Multi-project friendly** - Works across all your repos

## Customization

Muleteer is designed to work across multiple projects. Each project customizes its workflow via its own `CLAUDE.md` file:

```markdown
# In your-project/CLAUDE.md

## Project Modules

- **api** 🌐: REST API endpoints
- **frontend** 🎨: React UI components
- **database** 🗄️: Database layer

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

Example: 🌐✨ feat(api): Add user authentication endpoint
```

See `docs/CUSTOMIZATION.md` for detailed examples and patterns.

## Development

### Adding a New Skill

1. Create directory: `skills/your-skill-name/`
2. Create `SKILL.md` with frontmatter:
   ```markdown
   ---
   name: your-skill-name
   description: What this skill does
   tools:
     - github:*
   ---

   # Your Skill

   ## Purpose
   ...
   ```
3. Test locally: `./install.sh`
4. Commit and push

### Adding a New Command

1. Create `commands/your-command.md`
2. Use `$ARGUMENTS` for parameters
3. Test locally: `./install.sh`
4. Commit and push

### Adding a New Agent

1. Create `agents/your-agent.md`
2. Define specialized expertise
3. List required tools in frontmatter
4. Test locally: `./install.sh`
5. Commit and push

## Multi-Project Support

Muleteer is installed **once** globally but works across **all your projects**:

```bash
# One-time install
~/.muleteer/         # Generic workflow base
~/.claude/           # Symlinks to muleteer

# Per-project customization
~/projects/project-a/CLAUDE.md    # Project A's conventions
~/projects/project-b/CLAUDE.md    # Project B's conventions
~/projects/relica/CLAUDE.md       # Relica's conventions
```

Commands automatically detect the current project and read its `CLAUDE.md` for project-specific settings.

## Troubleshooting

### Skills not appearing
```bash
# Re-run install
~/.muleteer/install.sh

# Check symlinks
ls -la ~/.claude/skills/
```

### Commands not working
```bash
# Check for conflicts
ls -la ~/.claude/commands/

# Re-install
~/.muleteer/install.sh
```

### Update not taking effect
```bash
cd ~/.muleteer
git pull
./install.sh

# Restart Claude Code
```

## Contributing

Contributions welcome! To contribute:

1. Fork or clone this repo
2. Create feature branch
3. Add/modify skills, commands, or agents
4. Test with `./install.sh`
5. Submit PR with description of changes

## License

[Your License Here]

## Maintainer

Marc

## Version

**Current:** 1.0.0 (Initial release - migrated from .claude-crg)

**Changelog:**
- 1.0.0 (2025-12-27): Initial Muleteer release
  - Generic workflow system
  - Multi-project support
  - Migrated from CRG-specific implementation
