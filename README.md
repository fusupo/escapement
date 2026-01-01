# Muleteer

**Claude Code plugin for structured development workflows.** The donkey does the work, you do the driving.

## What This Is

Muleteer is a Claude Code plugin that provides reusable workflow modules to streamline your development process:

- **Skills**: Automated workflow modules (issue setup, commits, PRs, etc.)
- **Hooks**: Session archiving on compaction
- **Agents**: Specialized AI assistants (scratchpad-planner for codebase analysis)
- **Multi-Project Support**: Works across all your repos simultaneously

## Workflow Overview

Muleteer guides you from idea to merged code through a structured workflow:

1. **Initialize** (`issue-setup`) - Pull GitHub issue → Generate scratchpad plan → Create feature branch
2. **Execute** (`work-session` + `commit-changes`) - Work through scratchpad tasks → Make atomic commits
3. **Review** (`create-pr` + `review-pr`) - Create pull request → Review changes → Merge
4. **Archive** (`archive-work`) - Clean up scratchpad → Preserve session history

Each phase is handled by specialized skills that activate via natural language or explicit commands.

## Workflow Diagram

![Muleteer Workflow](/workflow.png "Development workflow from idea to merge")

## Installation

### From Source (Development)

```bash
# Clone the repository
git clone https://github.com/fusupo/muleteer.git

# Run Claude Code with the plugin
claude --plugin-dir /path/to/muleteer
```

### From Marketplace (Coming Soon)

```bash
# Once published to a marketplace
/plugin install muleteer
```

## Usage

### Skills

Skills are invoked automatically by Claude Code when relevant, or you can reference them explicitly with the `/muleteer:` prefix:

**Natural Language Invocation:**
```bash
# Claude uses the skill automatically based on context
"Setup GitHub issue #42"
"Commit these changes"
"Create a PR for this branch"
```

**Explicit Invocation:**
```bash
/muleteer:issue-setup
/muleteer:commit-changes
/muleteer:create-pr
```

### Available Skills

| Skill | Triggers | Purpose |
|-------|----------|---------|
| `issue-setup` | "setup issue #X", "start issue #X" | Fetch issue, create scratchpad, prepare branch |
| `commit-changes` | "commit", "commit these changes" | Smart commits with conventional format |
| `create-pr` | "create a PR", "open pull request" | Context-aware PR creation |
| `review-pr` | "review PR #X", "check this PR" | Roadmap-aware code review |
| `work-session` | "start working", "continue work" | Execute tasks from scratchpad |
| `archive-work` | "archive this work", "clean up" | Move completed scratchpads to archive |
| `prime-session` | "orient me", "what is this project" | Read project docs for context |

### Hooks

Muleteer includes a **PreCompact hook** that archives your session transcript before Claude Code's automatic compaction. This preserves your work history in `SESSION_LOG_{N}.md` files.

**Requirements:** `jq` must be installed for the hook to function.

### Agents

Specialized subagents for delegation and deep analysis:

#### scratchpad-planner

**Automatically invoked** during `issue-setup` (Phase 2) for codebase analysis and implementation planning.

**Capabilities:**
- Reads project's CLAUDE.md for conventions and structure
- Analyzes codebase using Grep, LSP, and code search patterns
- Identifies affected modules and integration points
- Finds similar implementations to learn from
- Generates atomic task breakdowns following project conventions
- Asks clarifying questions for ambiguous requirements
- Supports resumable analysis for complex codebases

**Benefits:**
- **Specialized expertise**: Replaces generic exploration with focused planning methodology
- **Project awareness**: Adapts to each project's conventions and architecture
- **Resumability**: Can be resumed across sessions for iterative refinement
- **Context preservation**: Maintains full analysis context, reducing repetition

The scratchpad-planner agent transforms GitHub issues into concrete, well-structured implementation plans with atomic, reviewable tasks.

## Structure

```
muleteer/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── skills/
│   ├── issue-setup/          # GitHub issue -> scratchpad workflow
│   ├── commit-changes/       # Conventional commits
│   ├── create-pr/            # Pull request creation
│   ├── review-pr/            # PR review
│   ├── work-session/         # Execute from scratchpad
│   ├── archive-work/         # Archive completed work
│   └── prime-session/        # Project orientation
├── hooks/
│   ├── hooks.json            # Hook configuration
│   └── archive-session-log.sh # Session archiving script
├── agents/                   # Specialized subagents
│   └── scratchpad-planner.md # Codebase analysis for issue-setup
├── docs/                     # Extended documentation
│   ├── WORKFLOW.md           # Workflow explanation
│   └── CUSTOMIZATION.md      # How to customize
├── workflow.png              # Workflow diagram
└── README.md                 # This file
```

## Philosophy

**Muleteer workflow principles:**

1. **Structured approach** - Clear workflow from issue to merge
2. **Incremental progress** - Atomic commits, reviewable changes
3. **Project awareness** - Adapts to each project's conventions
4. **Multi-project friendly** - Works across all your repos

## Per-Project Customization

Muleteer works across multiple projects. Each project customizes its workflow via its own `CLAUDE.md` file:

```markdown
# In your-project/CLAUDE.md

## Project Modules

- **api**: REST API endpoints
- **frontend**: React UI components
- **database**: Database layer

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

Example: feat(api): Add user authentication endpoint
```

See `docs/CUSTOMIZATION.md` for detailed examples and patterns.

## Development

### Adding a New Skill

1. Create directory: `skills/your-skill-name/`
2. Create `SKILL.md` with frontmatter:
   ```markdown
   ---
   name: your-skill-name
   description: What this skill does. Invoke when user says "trigger phrase".
   tools:
     - mcp__github__*
     - Read
     - Write
   ---

   # Your Skill

   ## Purpose
   ...
   ```
3. Test: `claude --plugin-dir /path/to/muleteer`
4. Commit and push

### Adding a New Agent

1. Create `agents/your-agent.md`
2. Define specialized expertise
3. List required tools in frontmatter
4. Test: `claude --plugin-dir /path/to/muleteer`
5. Commit and push

### Adding Hooks

Edit `hooks/hooks.json` following the [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks).

## Multi-Project Support

Muleteer is installed **once** as a plugin but works across **all your projects**:

```bash
# Load plugin
claude --plugin-dir /path/to/muleteer

# Per-project customization
~/projects/project-a/CLAUDE.md    # Project A's conventions
~/projects/project-b/CLAUDE.md    # Project B's conventions
~/projects/relica/CLAUDE.md       # Relica's conventions
```

Skills automatically detect the current project and read its `CLAUDE.md` for project-specific settings.

## Troubleshooting

### Plugin not loading

```bash
# Verify plugin structure
ls -la /path/to/muleteer/.claude-plugin/

# Should show:
# plugin.json

# Check manifest is valid JSON
cat /path/to/muleteer/.claude-plugin/plugin.json | jq .
```

### Skills not appearing

```bash
# Verify skills exist
ls -la /path/to/muleteer/skills/

# Restart Claude Code with plugin
claude --plugin-dir /path/to/muleteer
```

### Hooks not working

```bash
# Ensure jq is installed
which jq

# Check hooks.json is valid
cat /path/to/muleteer/hooks/hooks.json | jq .

# Verify hook script is executable
ls -la /path/to/muleteer/hooks/archive-session-log.sh
```

## Contributing

Contributions welcome! To contribute:

1. Fork or clone this repo
2. Create feature branch
3. Add/modify skills, hooks, or agents
4. Test with `claude --plugin-dir ./muleteer`
5. Submit PR with description of changes

## License

MIT

## Maintainer

fusupo

## Version

**Current:** 2.0.0 (Plugin architecture)

**Changelog:**
- 2.0.0 (2025-12-31): Converted to Claude Code plugin architecture
  - Replaced symlink installation with plugin manifest
  - Moved hooks to `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}`
  - Removed install.sh and uninstall.sh
  - Updated skill tool specifications
- 1.0.0 (2025-12-27): Initial Muleteer release
  - Generic workflow system
  - Multi-project support
  - Migrated from CRG-specific implementation
