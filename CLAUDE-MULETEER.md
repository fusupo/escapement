## Muleteer Workflow Context

**Muleteer** - Generic Claude Code workflow system for structured development.

### Development Philosophy

When working with Muleteer-enabled repos, follow these principles:

1. **Structured approach** - Clear workflow from issue to implementation to merge
2. **Incremental progress** - Each PR should advance project capabilities
3. **Atomic commits** - Small, reviewable changes that build on each other
4. **Project awareness** - Adapt to each project's specific conventions and architecture

### Workflow Conventions

- **Issues**: GitHub issues with clear acceptance criteria
- **Branches**: `{issue_number}-{description}` from main/develop
- **PRs**: Target project's main integration branch
- **Commits**: Conventional commits with emojis (customizable per project)
- **Testing**: Appropriate for project phase and requirements

### Commit Message Format

```
{module emoji}{change type emoji} {type}({scope}): {description}

{optional body explaining what and why}
```

**Change Type Emojis:**
- ✨ feat (new feature)
- 🐛 fix (bug fix)
- 📝 docs (documentation)
- 💄 style (formatting)
- ♻️ refactor (code refactoring)
- ⚡️ perf (performance)
- ✅ test (tests)
- 🔧 chore (tooling, config)
- 🚀 ci (CI/CD)
- 🗑️ revert (reverting changes)
- 🔥 fix (remove code or files)
- 🎨 style (improve structure/format)
- 🚑️ fix (critical hotfix)
- 🎉 chore (begin a project)
- 🔖 chore (release/version tags)
- 🚧 wip (work in progress)
- 💚 fix (fix CI build)
- 📌 chore (pin dependencies)
- 👷 ci (add or update CI build system)
- 📈 feat (add analytics or tracking code)
- ✏️ fix (fix typos)
- ⏪️ revert (revert changes)
- 📄 chore (add or update license)
- 💥 feat (introduce breaking changes)
- ♿️ feat (improve accessibility)
- 💡 docs (add or update comments)
- 🗃️ db (database related changes)
- 🔊 feat (add or update logs)
- 🔇 fix (remove logs)
- 🙈 chore (add or update .gitignore)

**Module Emojis:**

Projects can define their own module emojis in their repo's CLAUDE.md file. Example:

```markdown
## Project Modules

- **api** 🌐: REST API endpoints
- **frontend** 🎨: React UI components
- **database** 🗄️: Database layer
- **auth** 🔐: Authentication system
- **docs** 📚: Documentation
```

**Example Commit:**
```
🌐✨ feat(api): Add user authentication endpoint

Implements JWT-based authentication for API access.
Enables secure user login and session management.
```

### Quality Standards

- **Functional correctness** - Features work as designed
- **Code clarity** - Clear, maintainable code
- **API contracts** - Breaking changes need coordination
- **Documentation** - Complex patterns need explanation
- **Testing** - Appropriate test coverage for project phase

### Common Patterns

**Issue → Scratchpad → Implementation:**
```
1. Pull GitHub issue details
2. Analyze requirements
3. Create implementation plan (SCRATCHPAD_{num}.md)
4. Break into atomic tasks
5. Execute incrementally
6. Create PR with clear description
```

**Incremental Development:**
```
Small PR → Review → Merge → Repeat
- Each PR is independently reviewable
- Changes build on each other
- Continuous integration of work
```

### Never

- Don't mix unrelated changes in single commit
- Don't commit without testing core functionality
- Don't push directly to main (always PR)
- Don't skip commit message descriptions
- Don't leave debugging code or console.logs

### Per-Project Customization

Each project repo should have its own `CLAUDE.md` file that extends this base configuration with:

- Project-specific module emojis
- Architecture and component descriptions
- Development priorities and focus areas
- Project-specific conventions and standards
- Testing requirements and standards

**Example project CLAUDE.md structure:**

```markdown
# Project Name

## Architecture

[Describe your project's architecture]

## Project Modules

- **module1** 🎯: Description
- **module2** ⚙️: Description

## Development Focus

[Current development priorities]

## Standards

[Project-specific standards and conventions]
```

---

*This is the base Muleteer workflow context. Individual project repos should extend this with their own CLAUDE.md containing project-specific guidance.*
