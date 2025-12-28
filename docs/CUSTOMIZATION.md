# Customizing Muleteer for Your Project

Muleteer is designed to work across multiple projects, with each project customizing the workflow via its own `CLAUDE.md` file.

## Core Concept: Per-Project Configuration

**Global layer** (installed once):
```
~/.muleteer/          # Generic workflow base
~/.claude/            # Symlinks to muleteer
```

**Per-project layer** (in each repo):
```
~/projects/your-project/
├── CLAUDE.md         # Your project's customization
├── README.md
└── .git/
```

## Creating Your Project's CLAUDE.md

### Basic Template

Create `CLAUDE.md` in your project root:

```markdown
# [Project Name]

## Project Overview

[Brief description of what this project does]

## Architecture

[High-level architecture description]

### Project Modules

- **[module-name]** [emoji]: [Description]
- **[module-name]** [emoji]: [Description]
- **[module-name]** [emoji]: [Description]

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

{optional body explaining what and why}

**Examples:**
```
🌐✨ feat(api): Add user authentication endpoint
🎨🐛 fix(ui): Correct button alignment in header
```

## Development Focus

[Current development priorities and goals]

## Branch Strategy

- **Main branch:** [main/master/develop]
- **Feature branches:** [format: e.g., `{issue_number}-{description}`]
- **Integration branch:** [branch PRs target]

## Testing Standards

[Testing expectations for this project]

## Code Standards

[Linting, formatting, language-specific standards]
```

## Customization Examples

### Example 1: Full-Stack Web App

```markdown
# E-Commerce Platform

## Project Overview

Modern e-commerce platform with React frontend and Node.js backend.

## Architecture

Monorepo structure with separate packages for frontend, backend, and shared utilities.

### Project Modules

- **api** 🌐: REST API backend (Express + PostgreSQL)
- **frontend** 🎨: React SPA with TypeScript
- **database** 🗄️: Database migrations and schemas
- **auth** 🔐: Authentication and authorization
- **payments** 💳: Payment processing (Stripe integration)
- **admin** 👑: Admin dashboard
- **shared** 📦: Shared types and utilities

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

**Examples:**
```
🌐✨ feat(api): Add product search endpoint
🎨🐛 fix(frontend): Resolve cart calculation bug
🗄️♻️ refactor(database): Normalize order tables
```

## Development Focus

**Current Phase:** MVP completion

Priorities:
1. Core shopping cart functionality
2. Payment integration
3. Order management
4. Basic admin dashboard

## Branch Strategy

- **Main branch:** main
- **Integration branch:** develop
- **Feature branches:** `{issue_number}-{description}`
- **Hotfix branches:** `hotfix/{issue_number}-{description}`

## Testing Standards

- Unit tests for business logic
- Integration tests for API endpoints
- E2E tests for critical user flows (checkout, payment)
- Frontend: Jest + React Testing Library
- Backend: Jest + Supertest

## Code Standards

- TypeScript strict mode
- ESLint + Prettier
- Pre-commit hooks via Husky
- 80% coverage target for critical paths
```

### Example 2: Python Data Pipeline

```markdown
# Analytics Data Pipeline

## Project Overview

ETL pipeline processing analytics data from multiple sources.

## Architecture

Modular pipeline with separate stages for extraction, transformation, and loading.

### Project Modules

- **extractors** 📥: Data source extractors
- **transformers** ⚙️: Data transformation logic
- **loaders** 📤: Data warehouse loaders
- **models** 🔷: Data models and schemas
- **orchestration** 🎼: Airflow DAGs and scheduling
- **monitoring** 📊: Logging and alerting
- **infra** 🏗️: Infrastructure as code

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

**Examples:**
```
📥✨ feat(extractors): Add Salesforce API extractor
⚙️♻️ refactor(transformers): Simplify date normalization
🎼🐛 fix(orchestration): Correct retry logic in ETL DAG
```

## Development Focus

**Current Phase:** Production stabilization

Priorities:
1. Improve data quality checks
2. Add comprehensive error handling
3. Optimize slow transformations
4. Enhance monitoring and alerting

## Branch Strategy

- **Main branch:** main
- **Feature branches:** `feature/{issue_number}-{description}`
- **Bugfix branches:** `bugfix/{issue_number}-{description}`

## Testing Standards

- Unit tests for all transformers
- Integration tests with sample data
- Schema validation tests
- pytest + pytest-cov
- 90% coverage requirement

## Code Standards

- Python 3.11+
- Black formatting
- Pylint + mypy type checking
- Type hints required
- Docstrings for all public functions
```

### Example 3: Mobile App

```markdown
# Fitness Tracker Mobile App

## Project Overview

Cross-platform fitness tracking app built with React Native.

## Architecture

React Native with Redux state management, Firebase backend.

### Project Modules

- **ui** 🎨: UI components and screens
- **auth** 🔐: Authentication flows
- **tracking** 📍: Activity tracking (GPS, sensors)
- **data** 💾: Local storage and sync
- **backend** ☁️: Firebase Cloud Functions
- **notifications** 🔔: Push notifications
- **analytics** 📊: User analytics

## Commit Message Format

{module emoji}{change type emoji} {type}({scope}): {description}

**Examples:**
```
🎨✨ feat(ui): Add workout summary screen
📍🐛 fix(tracking): Improve GPS accuracy
💾♻️ refactor(data): Migrate to async storage
```

## Development Focus

**Current Phase:** Beta testing

Priorities:
1. Polish UI/UX based on beta feedback
2. Performance optimization
3. Offline mode improvements
4. Social features (sharing, friends)

## Branch Strategy

- **Main branch:** main
- **Development branch:** develop
- **Feature branches:** `feat/{issue_number}-{description}`
- **Release branches:** `release/v{version}`

## Testing Standards

- Jest for business logic
- React Native Testing Library for components
- Detox for E2E tests
- Manual testing on iOS and Android devices
- 70% coverage target

## Code Standards

- TypeScript strict mode
- ESLint + Prettier
- Component-driven development
- Atomic design principles
- Accessibility compliance (WCAG 2.1)
```

## Module Emoji Selection

Choose emojis that make sense for your modules:

### Common Module Types

**Frontend/UI:**
- 🎨 frontend/ui
- 📱 mobile
- 💄 styles
- 🖼️ components
- ✨ animations

**Backend/API:**
- 🌐 api/server
- 🔌 endpoints
- 🔧 services
- ⚙️ core

**Data/Database:**
- 🗄️ database
- 💾 storage
- 📊 analytics
- 🔍 search

**Auth/Security:**
- 🔐 auth
- 🔒 security
- 🛡️ permissions

**Infrastructure:**
- 🏗️ infrastructure
- 🐳 docker
- ☁️ cloud
- 🚀 deployment

**Documentation:**
- 📚 docs
- 📝 guides
- 📖 wiki

**Testing:**
- ✅ tests
- 🧪 integration
- 🔬 e2e

**Other:**
- 🤖 automation
- 🔔 notifications
- 💳 payments
- 📧 email
- 🎯 marketing

## Advanced Configuration

### Multiple Integration Branches

If your project has multiple integration branches:

```markdown
## Branch Strategy

- **Main branch:** main (production)
- **Staging branch:** staging (pre-production)
- **Development branch:** develop (active development)
- **Feature branches:** `{issue_number}-{description}` (from develop)
- **Hotfix branches:** `hotfix/{issue_number}` (from main)

**PR Targets:**
- Feature branches → develop
- Hotfixes → main + cherry-pick to develop
- Release branches → staging → main
```

### Team-Specific Conventions

```markdown
## Team Conventions

### Code Review

- All PRs require 2 approvals
- Review within 24 hours
- No PR > 400 lines (split if larger)

### Issue Management

- Use GitHub Projects for sprint planning
- Label issues with priority (P0-P3)
- Tag team members for expertise areas

### Communication

- Slack: #engineering for general, #deploys for releases
- Daily standup: 9:30 AM PT
- Sprint planning: Every other Monday
```

### Technology-Specific Standards

```markdown
## Technology Stack

- **Frontend:** React 18, TypeScript 5.0, Vite
- **Backend:** Node.js 20 LTS, Express, PostgreSQL 15
- **Testing:** Vitest, Playwright
- **Deployment:** Vercel (frontend), Railway (backend)

## Coding Patterns

### React Components

- Functional components only
- Custom hooks for shared logic
- Prop types via TypeScript interfaces
- One component per file

### API Design

- RESTful conventions
- Versioned endpoints (/api/v1/)
- JSON responses
- Consistent error format
```

## Integration with Commands

### `/commit` Command

Reads your `CLAUDE.md` to determine:
- Which module emojis to use
- Project-specific scope naming
- Commit message format preferences

### `/open-pr` Command

Reads your `CLAUDE.md` to determine:
- Target branch for PRs
- Project goals for PR description
- Testing standards to mention

### `/pr-review` Command

Reads your `CLAUDE.md` to understand:
- Project priorities
- Development phase
- Standards to check against

### `issue-setup` Skill

Reads your `CLAUDE.md` to:
- Understand module boundaries
- Apply branch naming conventions
- Generate context-aware implementation plans

## Best Practices

### 1. Keep It Updated

Update CLAUDE.md when:
- Adding new modules
- Changing development priorities
- Shifting to new project phase
- Adopting new technologies

### 2. Be Specific

**Good:**
```markdown
## Testing Standards

- Unit tests for all business logic (Jest)
- Integration tests for API endpoints (Supertest)
- E2E tests for critical flows (Playwright)
- 80% coverage minimum
- All tests must pass before PR approval
```

**Too vague:**
```markdown
## Testing Standards

Write tests for your code.
```

### 3. Include Examples

Show actual commit messages, branch names, PR descriptions from your project.

### 4. Document Current State

Focus on where the project is NOW, not where it might be in the future.

### 5. Team Collaboration

Treat CLAUDE.md as a living document:
- Review in team meetings
- Update based on retrospectives
- Keep aligned with team practices

## Sharing Configurations

### Public Open Source

For public projects, CLAUDE.md helps contributors understand:
- Project structure
- Contribution guidelines
- Development workflow

### Private Team Projects

For team projects, CLAUDE.md ensures:
- Consistent commit messages across team
- Shared understanding of modules
- Aligned development practices

### Multiple Related Projects

For related projects (microservices, monorepo), maintain separate CLAUDE.md files that share common patterns but customize for each service.

## Troubleshooting

### Commands not using my module emojis

1. Check CLAUDE.md is in project root
2. Verify "## Project Modules" section exists
3. Ensure emoji format: `- **name** emoji: description`
4. Re-run `/prime-session` to refresh context

### PRs targeting wrong branch

Update "Branch Strategy" section in CLAUDE.md:
```markdown
## Branch Strategy

- **Integration branch:** develop
```

### Module names not recognized

Check "Project Modules" section uses consistent naming:
```markdown
- **api** 🌐: Backend API
```

Then use "api" as scope in commits: `feat(api): ...`

## Migration Guide

### Migrating Existing Project

1. Create `CLAUDE.md` in project root
2. Start with basic template
3. Document existing modules
4. Add current conventions
5. Test with `/commit` command
6. Refine based on actual usage

### Standardizing Across Team

1. One person drafts CLAUDE.md
2. Review in team meeting
3. Iterate based on feedback
4. Commit to repo
5. Reference in CONTRIBUTING.md

## Summary

Muleteer's per-project configuration:
- **Keeps global workflow generic** - Works everywhere
- **Customizes per project** - Each project has its own conventions
- **Supports multiple projects** - No global config conflicts
- **Team-friendly** - Shared CLAUDE.md ensures consistency
- **Living document** - Evolves with your project

The key is maintaining a clear CLAUDE.md in each project root that reflects current reality, not aspirational future state.
