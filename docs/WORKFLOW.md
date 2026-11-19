# Escapement Workflow Guide

This document explains how Escapement's skills work together to create a structured development workflow. Each stage is a skill you invoke in plain words ("Start working on issue #42") or explicitly (`/escapement:do-work`). For installing the plugin and the full list of skills, see the [README](../README.md).

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

On projects set up for the factory (required checks configured in `## Escapement Settings`), it also checks readiness, proposes a risk tier and adds a Validation Contract to the scratchpad. A fresh-context `plan-critic` then checks the plan and contract once; the planner answers its findings, and any it rejects that matter are shown to you with both positions at approval (`## Plan Critique` in the scratchpad). Plan approval then offers **Approve + authorize run**, which checks out the branch and starts and approves a factory run for that contract (see [FACTORY_CLI.md](FACTORY_CLI.md)). Plain approval works as before.

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
"Start working on issue #42"
```

**What happens:**
The `do-work` skill:
1. Loads `SCRATCHPAD_{num}.md`
2. Displays current checklist
3. Switches to feature branch (if needed)
4. Works through each unchecked task:
   - Implement changes
   - Commit each atomic change with `commit-changes`
   - Update scratchpad with progress notes
   - Check off completed items

**Commit workflow:**
```
"Commit these changes"
```
The `commit-changes` skill:
- Analyzes staged/unstaged changes
- Reads project's CLAUDE.md for module emojis
- Creates conventional commit with appropriate emojis
- Follows project-specific conventions
- Commits as the AI agent when an agent identity is configured, otherwise as you (see the README's [GitHub as the AI Agent](../README.md#github-as-the-ai-agent))

**Example commit:**
```
🌐✨ feat(api): Add user authentication endpoint

Implements JWT-based authentication for API access.
Enables secure user login and session management.
```

**Continuous sync:**
- Push changes every 2-3 commits (`do-work` offers to, and pushes the branch as the agent)
- Keep scratchpad updated with notes
- If blocked, add to Questions/Blockers section

**Authorized factory run:** when plan approval was **Approve + authorize run**, `do-work` asks no questions. It works through the tasks with builds and tests through `factory exec`, and commits each one as the AI agent. Then it validates (`validate-work`: the runner's checks, a fresh-context reviewer, the recorded verdict) and opens the PR (`create-pr` through `factory pr`, as the agent's GitHub account, with the validation report). When an attempt fails on something it can fix, such as a failing test or a reviewer's blocking finding, the run goes back to implementing on its own: it fixes those findings and validates again, within `max-attempts` (the fix loop, since 4.1.0). If something stops it, it escalates the run, notifies you and stops. After a failed attempt, `do-work` then offers to fix it and continue the same run, abandon it, or start over. Your next touch is reviewing and merging the PR. This needs the agent's token as `ESCAPEMENT_AGENT_GH_TOKEN`, in `~/.config/escapement/agent.env` or the environment. The runner's commands, states and settings are in [FACTORY_CLI.md](FACTORY_CLI.md).

---

### 5. Nuke Branch (If Needed)

**When:** Issue is too big or approach needs reconceptualization

**Action:**
- Archive the scratchpad with `archive-work` ("Archive this work"). It goes to the project's context path, `{context-path}/{branch}/archive/`, or to `docs/dev/cc-archive/` in the repo only when no context path is set (see [CONTEXT_PATH.md](CONTEXT_PATH.md))
- Create new issue(s) with better scope
- Start fresh with new approach

---

### 6. Create PR (Open Pull Request)

**Trigger:**
```
"Create a PR"
```

**What happens:**
The `create-pr` skill:
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
6. Pushes the branch and opens the PR as the AI agent when an agent identity is configured. Under an authorized factory run it goes through `factory pr`, with the validation report in the description ([FACTORY_CLI.md](FACTORY_CLI.md))

**Output:**
- Well-structured PR ready for review
- Linked to originating issue
- Clear description of what and why

---

### 7. Review PR (Code Review)

**Trigger:**
```
"Review PR #123"
```

**What happens:**
The `review-pr` skill provides:
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
"Archive this work"
```

**What happens:**
The `archive-work` skill:
- Moves `SCRATCHPAD_{num}.md` and the session logs to the project's context path, `{context-path}/{branch}/archive/`, with a README summary, and adds a row to `{context-path}/INDEX.md`
- Without a context path, archives in the repo under `docs/dev/cc-archive/` instead, and offers to commit it
- Closes the branch's factory run, if it has one
- Workspace stays clean for next task

See [CONTEXT_PATH.md](CONTEXT_PATH.md) for setting the context path.

---

## Supporting Skills

### `prime-session`
**Purpose:** Orient to current project

**Trigger:** "Orient me", "What is this project"

**What it does:**
- Reviews project's CLAUDE.md
- Reviews README and architecture docs
- Provides context without taking action

**When to use:**
- Starting work in a new project
- Switching between projects
- Need refresh on project structure

### `commit-changes`
**Purpose:** Create conventional commits

**Trigger:** "Commit these changes"

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

Escapement is a Claude Code plugin: install it once (see the README's [Installation](../README.md#installation)) and it works across all your projects:

```bash
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
- Skills detect current git repo
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

### Skills not found, or the plugin isn't loading
See the README's [Troubleshooting](../README.md#troubleshooting): check the plugin manifest, the skill directories and the `--plugin-dir` you started Claude Code with.

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

Skills and agents live in the plugin's `skills/` and `agents/` directories. The steps are in the README: [Adding a New Skill](../README.md#adding-a-new-skill) and [Adding a New Agent](../README.md#adding-a-new-agent). Per-project conventions go in each project's CLAUDE.md (see [CUSTOMIZATION.md](CUSTOMIZATION.md)).

## Summary

Escapement provides structure without rigidity:
- **Automated:** Issue → Scratchpad → Branch → PR
- **Contextual:** Reads each project's conventions
- **Flexible:** Works across all your projects
- **Incremental:** Small, atomic, reviewable changes

The workflow keeps you focused on building while handling the ceremony of structured development.
