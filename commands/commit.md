allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*), Bash(git diff:*), Bash(git log:*), Bash(git branch:*)
description: Create a thoughtful git commit with conventional commits format
---

## Analysis Required

First, gather project and git context using Claude's tools:

1. **Project Context**: Read PROJECT_CONTEXT.md or CLAUDE.md for current development approach
2. **Git Context**: Use Bash tools to understand the development context:
   - Current git status
   - Staged vs unstaged changes 
   - Current branch
   - Recent commits
   - File details for staged changes

## Your Task
Analyze the changes and create a single, meaningful git commit that aligns with the project's current development phase and priorities:

### 1. **Stage appropriate files**
Review unstaged changes and stage files that belong together logically:
- Group module-related changes together
- Consider the incremental development philosophy when grouping changes
- Align with project's current priorities

### 2. **Craft commit message** following this format:
   ```
   {module emoji}{change type emoji} {type}({scope}): {description}
   
   {optional body explaining the what and why}
   ```

#### **Commit message guidelines:**
- **Type**: Use conventional commits (feat, fix, docs, style, refactor, test, chore)
- **Module Emoji**: Use emoji to reference the affected module(s)
  - Check the project's CLAUDE.md for module-specific emojis
  - Example: 🌐 api, 🎨 frontend, 🗄️ database, 🔐 auth, 📚 docs
  - Each project defines its own module structure and emojis
- **Change Type Emoji**: Choose meaningful emoji for the commit type 
  - ✨ feat: New feature
   - 🐛 fix: Bug fix
   - 📝 docs: Documentation
   - 💄 style: Formatting/style
   - ♻️ refactor: Code refactoring
   - ⚡️ perf: Performance improvements
   - ✅ test: Tests
   - 🔧 chore: Tooling, configuration
   - 🚀 ci: CI/CD improvements
   - 🗑️ revert: Reverting changes
   - 🧪 test: Add a failing test
   - 🚨 fix: Fix compiler/linter warnings
   - 🔒️ fix: Fix security issues
   - 👥 chore: Add or update contributors
   - 🚚 refactor: Move or rename resources
   - 🏗️ refactor: Make architectural changes
   - 🔀 chore: Merge branches
   - 📦️ chore: Add or update compiled files or packages
   - ➕ chore: Add a dependency
   - ➖ chore: Remove a dependency
   - 🌱 chore: Add or update seed files
   - 🧑‍💻 chore: Improve developer experience
   - 🧵 feat: Add or update code related to multithreading or concurrency
   - 🔍️ feat: Improve SEO
   - 🏷️ feat: Add or update types
   - 💬 feat: Add or update text and literals
   - 🌐 feat: Internationalization and localization
   - 👔 feat: Add or update business logic
   - 📱 feat: Work on responsive design
   - 🚸 feat: Improve user experience / usability
   - 🩹 fix: Simple fix for a non-critical issue
   - 🥅 fix: Catch errors
   - 👽️ fix: Update code due to external API changes
   - 🔥 fix: Remove code or files
   - 🎨 style: Improve structure/format of the code
   - 🚑️ fix: Critical hotfix
   - 🎉 chore: Begin a project
   - 🔖 chore: Release/Version tags
   - 🚧 wip: Work in progress
   - 💚 fix: Fix CI build
   - 📌 chore: Pin dependencies to specific versions
   - 👷 ci: Add or update CI build system
   - 📈 feat: Add or update analytics or tracking code
   - ✏️ fix: Fix typos
   - ⏪️ revert: Revert changes
   - 📄 chore: Add or update license
   - 💥 feat: Introduce breaking changes
   - 🍱 assets: Add or update assets
   - ♿️ feat: Improve accessibility
   - 💡 docs: Add or update comments in source code
   - 🗃️ db: Perform database related changes
   - 🔊 feat: Add or update logs
   - 🔇 fix: Remove logs
   - 🤡 test: Mock things
   - 🥚 feat: Add or update an easter egg
   - 🙈 chore: Add or update .gitignore file
   - 📸 test: Add or update snapshots
   - ⚗️ experiment: Perform experiments
   - 🚩 feat: Add, update, or remove feature flags
   - 💫 ui: Add or update animations and transitions
   - ⚰️ refactor: Remove dead code
   - 🦺 feat: Add or update code related to validation
   - ✈️ feat: Improve offline support
- **Scope**: Use module names when applicable (check project's CLAUDE.md for module names)
- **Description**: Imperative mood, no period, under 50 chars, focus on capability/value added
- **Body**: Explain what and why in context of project goals, not implementation details

#### **Project-aware staging logic:**
- Separate incremental improvements from new capabilities
- Don't mix module boundaries unless it's explicit integration work
- Exclude debugging artifacts, temp files, or incomplete experiments
- If multiple logical changes exist, prioritize based on project roadmap (check CLAUDE.md)

**Smart staging logic:**
- Don't commit unrelated changes together
- If multiple logical changes exist, ask which to commit first
- Exclude temp files, logs, or accidental changes

**Quality checks:**
- Ensure commit represents one logical change
- Message clearly describes the impact
- No debugging code or console.logs included

IMPORTANT: No Claude attribution in commit messages.
