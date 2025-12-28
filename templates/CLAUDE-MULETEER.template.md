# [Project Name]

## Project Overview

[Brief description of what this project does and its purpose]

## Architecture

[High-level architecture description - components, services, layers]

### Project Modules

Define your project's modules and their emojis for commit messages:

- **[module-name]** [emoji]: [Description of what this module does]
- **[module-name]** [emoji]: [Description]
- **[module-name]** [emoji]: [Description]

**Examples:**
```markdown
- **api** 🌐: REST API backend
- **frontend** 🎨: React UI components
- **database** 🗄️: Database layer and migrations
- **auth** 🔐: Authentication and authorization
- **docs** 📚: Documentation
```

## Commit Message Format

Muleteer uses this format for commits:

```
{module emoji}{change type emoji} {type}({scope}): {description}

{optional body explaining what and why}
```

**Examples using your modules:**
```
🌐✨ feat(api): Add user authentication endpoint
🎨🐛 fix(frontend): Correct button alignment in header
🗄️♻️ refactor(database): Normalize user tables
```

**Change Type Emojis** (built into Muleteer):
- ✨ feat - New feature
- 🐛 fix - Bug fix
- 📝 docs - Documentation
- ♻️ refactor - Code refactoring
- ⚡️ perf - Performance improvement
- ✅ test - Tests
- 🔧 chore - Tooling, configuration
- [See CLAUDE-MULETEER.md for full list]

## Development Focus

**Current Phase:** [e.g., MVP, Beta, Production, etc.]

**Priorities:**
1. [Current priority #1]
2. [Current priority #2]
3. [Current priority #3]

**Goals:**
- [What you're trying to achieve]
- [Key milestones or capabilities]

## Branch Strategy

- **Main branch:** [main/master]
- **Integration branch:** [develop/staging - branch where PRs are merged]
- **Feature branches:** [format: e.g., `{issue_number}-{description}`]
- **Hotfix branches:** [format if different from features]

## Testing Standards

**Test Framework:** [Jest, pytest, etc.]

**Coverage:**
- [Coverage requirements/targets]
- [What needs tests vs. what doesn't]

**Test Types:**
- **Unit tests:** [Scope and requirements]
- **Integration tests:** [Scope and requirements]
- **E2E tests:** [Scope and requirements]

## Code Standards

**Language/Framework:**
- [Primary language and version]
- [Framework and version]

**Linting/Formatting:**
- [Linter: ESLint, Pylint, etc.]
- [Formatter: Prettier, Black, etc.]
- [Pre-commit hooks if applicable]

**Coding Patterns:**
- [Architectural patterns to follow]
- [File organization conventions]
- [Naming conventions]

## Team Conventions

### Code Review
- [PR approval requirements]
- [Review timeframes]
- [PR size guidelines]

### Issue Management
- [Issue tracker: GitHub Issues, Linear, Jira]
- [Labeling system]
- [Assignment practices]

### Communication
- [Team communication channels]
- [Meeting schedules]
- [Escalation paths]

---

## Development Workflow

[Optional: Describe any project-specific workflow steps]

## Technical Decisions

[Optional: Document key architectural decisions and rationale]

## Resources

[Optional: Links to additional documentation, wikis, runbooks]

---

**Last Updated:** [Date]
**Maintained By:** [Team/Person]
