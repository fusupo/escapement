# Escapement Workflow Guide

This document explains how Escapement's components work together to create a structured development workflow.

## Overview

Escapement automates the common pattern of:
1. **Issue** → 2. **Plan** → 3. **Implement** → 4. **Review** → 5. **Merge**

## Workflow Stages

### 1. Initial Planning (Have Idea)

**What happens:**
- Chat with Claude about your approach
- Establish GitHub issue with clear problem statement
- Define acceptance criteria

**Escapement support:**
- Issues should be problem-focused, not solution-prescriptive
- Clear acceptance criteria enable better automation

---

### 2. Issue Setup (Pull Issue)

**Trigger:**
```
"Setup GitHub issue #42"
```

**What happens:**
The `setup-work` skill automatically:
1. Fetches complete issue details from GitHub
2. Analyzes requirements and codebase context
3. Creates `SCRATCHPAD_{num}.md` with:
   - Issue details and acceptance criteria
   - Implementation plan broken into atomic tasks
   - Technical notes and architecture considerations
   - Questions/blockers flagged upfront
4. Creates feature branch: `{issue_number}-{description}`

**Output:**
- `SCRATCHPAD_42.md` - Your implementation roadmap
- Feature branch ready for work
- Clear understanding of scope before coding starts

---

### 3. Deep Dive Solution (Analyze & Plan)

**What happens:**
Review the generated scratchpad:
- Implementation tasks are atomic and logical
- Architecture considerations are documented
- Potential challenges are flagged
- You understand exactly what to build

**Your role:**
- Approve the plan or request refinement
- Clarify any questions in the Questions/Blockers section
- Decide if issue scope is appropriate or needs splitting

**Best practice:**
Don't start coding until the scratchpad makes sense. A good scratchpad should be clear enough for another developer to execute.

---

### 4. Execute (Do Work)

**Trigger:**
```
/start-work
```

**What happens:**
The `start-work` command:
1. Loads `SCRATCHPAD_{num}.md`
2. Displays current checklist
3. Switches to feature branch (if needed)
4. Works through each unchecked task:
   - Implement changes
   - Use `/commit` for each atomic change
   - Update scratchpad with progress notes
   - Check off completed items

**Commit workflow:**
```
/commit
```
- Analyzes staged/unstaged changes
- Reads project's CLAUDE.md for module emojis
- Creates conventional commit with appropriate emojis
- Follows project-specific conventions

**Example commit:**
```
🌐✨ feat(api): Add user authentication endpoint

Implements JWT-based authentication for API access.
Enables secure user login and session management.
```

**Continuous sync:**
- Push changes every 2-3 commits
- Keep scratchpad updated with notes
- If blocked, add to Questions/Blockers section

---

### 5. Nuke Branch (If Needed)

**When:** Issue is too big or approach needs reconceptualization

**Action:**
- Archive scratchpad to `docs/dev/cc-archive/`
- Create new issue(s) with better scope
- Start fresh with new approach

---

### 6. Create PR (Open Pull Request)

**Trigger:**
```
/open-pr
```

**What happens:**
The `open-pr` command:
1. Analyzes branch commits and changes
2. Extracts issue reference from branch name
3. Retrieves issue details for context
4. Generates PR description:
   - Summary aligned with issue goals
   - Key changes by module
   - Project progress indicator
   - Testing approach
5. Auto-configures:
   - Labels from issue + modules affected
   - Target branch (from CLAUDE.md or default)
   - Draft status if work-in-progress
   - Issue linking (auto-close on merge)

**Output:**
- Well-structured PR ready for review
- Linked to originating issue
- Clear description of what and why

---

### 7. Review PR (Code Review)

**Trigger:**
```
/pr-review <pr-number>
```

**What happens:**
The `pr-review` command provides:
1. **Issue Hierarchy Detection:**
   - Identifies parent epic/initiative
   - Finds sibling issues in same epic
   - Maps dependencies
2. **Sprint/Roadmap Context:**
   - Lists current sprint/milestone issues
   - Understands project position
   - Identifies planned improvements
3. **Multi-Perspective Review:**
   - Product value assessment
   - Technical implementation review
   - Epic integration & coordination
   - Sprint-aware quality assessment
   - Roadmap impact analysis

**Key benefit:**
Avoids suggesting improvements already planned in backlog. Focuses on THIS piece within larger project context.

---

### 8. Merge PR (Approved)

**What happens:**
- PR merges to main integration branch
- Issue auto-closes (if properly linked)
- Feature branch can be deleted

---

### 9. Archive Scratchpad (Clean Up)

**Trigger:**
```
/archive-dev
```

**What happens:**
- Moves `SCRATCHPAD_{num}.md` to archive location
- Commits archive
- Workspace stays clean for next task

---

## Supporting Commands

### `/prime-session`
**Purpose:** Orient to current project

**What it does:**
- Reviews project's CLAUDE.md
- Reviews README and architecture docs
- Provides context without taking action

**When to use:**
- Starting work in a new project
- Switching between projects
- Need refresh on project structure

### `/commit`
**Purpose:** Create conventional commits

**What it does:**
- Analyzes git status and changes
- Reads project CLAUDE.md for conventions
- Generates commit with module + change type emojis
- Follows project-specific format

**When to use:**
- After completing atomic task from scratchpad
- Any time you need a well-formatted commit

## File Patterns

### Scratchpad Files
- **Location:** Project root
- **Format:** `SCRATCHPAD_{issue_number}.md`
- **Purpose:** Implementation plan and progress tracking
- **Lifecycle:** Created by `setup-work`, updated during work, archived when done

### Project CLAUDE.md
- **Location:** Project root (each repo has its own)
- **Purpose:** Project-specific configuration
- **Contains:**
  - Module definitions and emojis
  - Architecture overview
  - Development priorities
  - Branch naming conventions
  - Standards and practices

## Multi-Project Usage

Escapement works across all your projects simultaneously:

```bash
# Global install (once)
~/.escapement/          # Generic workflow base
~/.claude/            # Symlinks to muleteer

# Per-project customization
~/projects/project-a/
├── CLAUDE.md         # Project A's conventions
├── SCRATCHPAD_42.md  # Active work
└── .git/

~/projects/project-b/
├── CLAUDE.md         # Project B's conventions
├── SCRATCHPAD_15.md  # Active work
└── .git/
```

**How it works:**
- Commands detect current git repo
- Read that project's CLAUDE.md for settings
- Apply project-specific conventions automatically
- Each project maintains its own workflow state

## Best Practices

### 1. Problem-Focused Issues
- Describe the problem, not the solution
- Clear acceptance criteria
- Single, focused scope

### 2. Trust the Scratchpad
- Don't code until plan makes sense
- Flag ambiguities early
- Request clarification before starting

### 3. Atomic Commits
- One logical change per commit
- Commit after each scratchpad task
- Clear, descriptive messages

### 4. Keep Scratchpad Updated
- Add notes during implementation
- Document decisions made
- Update Questions/Blockers section

### 5. Project-Specific Conventions
- Maintain CLAUDE.md in each repo
- Define modules and emojis
- Document architecture
- Set development priorities

### 6. Incremental Progress
- Small, reviewable PRs
- Each PR advances project
- Build on previous work
- Avoid scope creep

## Troubleshooting

### "Skill not found"
```bash
cd ~/.escapement
./install.sh
```

### "Command not working"
Check symlinks: `ls -la ~/.claude/commands/`

### "Wrong module emojis"
Update project's `CLAUDE.md` with correct modules

### "Can't find scratchpad"
Ensure you're in project root directory

## Advanced Usage

### Custom Project Setup

Create `CLAUDE.md` in your project:

```markdown
# Project Name

## Project Modules

- **api** 🌐: REST API endpoints
- **frontend** 🎨: React components
- **database** 🗄️: Database layer
- **auth** 🔐: Authentication

## Development Philosophy

[Your approach]

## Standards

[Your standards]
```

### Extending Escapement

Add custom commands:
1. Create `~/.escapement/commands/your-command.md`
2. Run `~/.escapement/install.sh`
3. Use `/your-command` in any project

Add custom skills:
1. Create `~/.escapement/skills/your-skill/SKILL.md`
2. Add frontmatter with tools needed
3. Run `~/.escapement/install.sh`
4. Invoke automatically or explicitly

## Summary

Escapement provides structure without rigidity:
- **Automated:** Issue → Scratchpad → Branch → PR
- **Contextual:** Reads each project's conventions
- **Flexible:** Works across all your projects
- **Incremental:** Small, atomic, reviewable changes

The workflow keeps you focused on building while handling the ceremony of structured development.
