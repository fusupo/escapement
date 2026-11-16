---
name: commit-changes
description: Create thoughtful git commits with conventional commits format. Invoke when user says "commit", "commit these changes", "create a commit", "save my changes", or after completing a task.
tools:
  - mcp__serena__*
  - Bash:git *
  - Bash:bash *
  - Read
  - Grep
  - AskUserQuestion
  - TodoWrite
---

# Commit Changes Skill

## Purpose

Create well-structured git commits following conventional commits format with project-aware module emojis. This skill analyzes changes, crafts meaningful commit messages, and ensures commits are atomic and purposeful.

## Natural Language Triggers

This skill activates when the user says things like:
- "Commit these changes"
- "Create a commit"
- "Commit this"
- "Save my changes"
- "Make a commit for this work"
- After completing a scratchpad task: "Done with this task, commit it"

## Workflow Execution

### Phase 0: Authorized Run Check

A factory run approved with setup-work's "Approve + authorize run" authorizes commits on its branch (docs/FACTORY_DESIGN.md §3.6, §6.1). Ask the runner whether this worktree has one:

```bash
FACTORY="${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"
bash "$FACTORY" --check && bash "$FACTORY" --json authorization
```

- **`--check` fails, `.result.matched` is false, or `.result.authorizes` lacks `commit`:** not authorized. Go to Phase 0.5 for the commit identity; everything else below runs exactly as written, with every confirmation.
- **Matched, with `commit`:** authorized. Note `.result.run_id`, then get the agent's commit identity:
  ```bash
  bash "$FACTORY" --json agent
  ```
  If it fails (`no_agent_token`), stop without committing: "Commits under factory run {run_id} carry the AI agent's identity: put ESCAPEMENT_AGENT_GH_TOKEN (or ESCAPEMENT_AGENT_NAME and ESCAPEMENT_AGENT_EMAIL) in ~/.config/escapement/agent.env (chmod 600), or export it." On `agent_env_permissions`, say what the message says: the file needs `chmod 600`. Never fall back to the operator's identity. Otherwise note `.result.name` and `.result.email` as written.

**Under authorization the approved plan stands in for the confirmations:**
- **Phase 2:** several logical changes become several commits, in a sensible order, without asking which first.
- **Phase 4:** skipped. Show the message; don't ask.
- **Phase 5:** stage explicit paths only (never `git add -A` or `git add .`), and commit as the agent, author and committer both:
  ```bash
  git -c user.name="{name}" -c user.email="{email}" commit -m "$(cat <<'EOF'
  {message}
  EOF
  )"
  ```
- **Never** push (`factory pr` does that), amend or rewrite a commit already made, or commit a file that doesn't belong to the work: an untracked file you didn't create, or anything that looks like a secret. Leave it, report it and stop; the caller (do-work) escalates the run.

### Phase 0.5: Commit Identity (plain path)

Outside an authorized run, commits still carry the AI agent's identity when one is configured, so Escapement's work is visibly the agent's, not the operator's (docs/FACTORY_DESIGN.md §4.8). Ask the runner for it:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" --check && bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" --json agent
```

Never read or print `~/.config/escapement/agent.env` yourself.

- **`.ok`:** note `.result.name` and `.result.email` as written. Phase 4 shows them as the author, and Phase 5 commits with them.
- **`--check` fails, or `.error.code` is `no_agent_token`:** no agent identity is configured. Commit with the operator's own git identity, as before, and say so in one line: `Committing as the operator: no agent identity configured (put ESCAPEMENT_AGENT_GH_TOKEN, or ESCAPEMENT_AGENT_NAME and ESCAPEMENT_AGENT_EMAIL, in ~/.config/escapement/agent.env, chmod 600, or export it)`.
- **`agent_env_permissions`:** an identity is configured but the file is readable by others. Stop without committing and say what the message says: the file needs `chmod 600`. Don't fall back.
- **Any other error** (such as `gh_failed` while looking up the token's account): report it and stop without committing. Never fall back to the operator for a configured identity that failed.

### Phase 1: Gather Context (Parallel)

Execute these in parallel for efficiency:

1. **Project Context:**
   - Read project's `CLAUDE.md` for module emojis and conventions
   - Identify current development phase/priorities

2. **Git Context:**
   - `git status` - See staged/unstaged changes
   - `git diff --cached` - Review staged changes (if any)
   - `git diff` - Review unstaged changes
   - `git branch --show-current` - Current branch
   - `git log --oneline -5` - Recent commits for style reference

### Phase 2: Analyze Changes

1. **Categorize Changes:**
   - Which files are modified/added/deleted?
   - Which module(s) are affected?
   - What type of change is this? (feat, fix, refactor, docs, etc.)

2. **Staging Decision:**
   - If nothing staged but changes exist: Determine what should be staged together
   - Group logically related changes
   - Don't mix unrelated changes in one commit
   - If multiple logical changes exist, use `AskUserQuestion` to ask which to commit first

3. **Exclude Workflow Artifacts:**
   - **NEVER stage or commit** `SCRATCHPAD_*.md` files (working implementation plans)
   - **NEVER stage or commit** `SESSION_LOG_*` files (session transcripts, `.jsonl` or `.md`)
   - If these appear in `git status`, ignore them — they are ephemeral workflow files

4. **Validate Commit-Worthiness:**
   - Ensure changes represent one logical unit of work
   - Check for debugging code, console.logs, temp files
   - Verify no secrets or sensitive data included

### Phase 3: Craft Commit Message

When the project's CLAUDE.md defines its own commit format, use that format instead of the default below; its module emojis and scopes come from there too.

**Format:**
```
{module emoji}{change type emoji} {type}({scope}): {description}

{optional body explaining what and why}
```

**Components:**

1. **Module Emoji:** From project's CLAUDE.md
   - Check `## Project Modules` section for project-specific emojis
   - Default examples: 🌐 api, 🎨 frontend, 🗄️ database, 🔐 auth, 📚 docs
   - Use the most specific module that applies

2. **Change Type Emoji:**
   - ✨ feat: New feature
   - 🐛 fix: Bug fix
   - 📝 docs: Documentation
   - 💄 style: Formatting/style
   - ♻️ refactor: Code refactoring
   - ⚡️ perf: Performance improvements
   - ✅ test: Tests
   - 🔧 chore: Tooling, configuration
   - 🚀 ci: CI/CD improvements
   - 🔥 fix: Remove code or files
   - 🎨 style: Improve structure/format
   - 🚑️ fix: Critical hotfix
   - 🎉 chore: Begin a project
   - 🏗️ refactor: Architectural changes
   - 🏷️ feat: Add or update types
   - ⚰️ refactor: Remove dead code

3. **Type:** Conventional commit type (feat, fix, docs, style, refactor, perf, test, chore, ci)

4. **Scope:** Module name from CLAUDE.md (e.g., api, frontend, skills)

5. **Description:**
   - Imperative mood ("Add feature" not "Added feature")
   - No period at end
   - Under 50 characters
   - Focus on capability/value added

6. **Body (optional):**
   - Explain what and why, not how
   - Context for the change
   - Reference issue numbers if applicable

### Phase 4: Confirm with User

Under an authorized run (Phase 0), skip this phase. Otherwise use `AskUserQuestion` to confirm the commit:

```
AskUserQuestion:
  question: "Ready to commit with this message?"
  header: "Commit"
  options:
    - label: "Yes, commit"
      description: "Create the commit with this message"
    - label: "Edit message"
      description: "I want to modify the commit message"
    - label: "Stage more files"
      description: "I need to include additional files"
    - label: "Cancel"
      description: "Don't commit right now"
```

Display the proposed commit message clearly before asking, with the author it will carry: the agent's `{name} <{email}>`, or "the operator (no agent identity configured)".

### Phase 5: Execute Commit

1. **Stage files** (if not already staged):
   ```bash
   git add <files>
   ```

2. **Create commit** using HEREDOC for proper formatting. With the agent identity from Phase 0.5, commit as the agent, author and committer both:
   ```bash
   git -c user.name="{name}" -c user.email="{email}" commit -m "$(cat <<'EOF'
   {module emoji}{type emoji} {type}({scope}): {description}

   {body if present}
   EOF
   )"
   ```
   Without one (`no_agent_token`), the same command without the two `-c` options, so the operator's git identity applies.

   **IMPORTANT:** Do NOT add Claude attribution (e.g., "Co-Authored-By: Claude") to commit messages.

3. **Confirm success:**
   ```bash
   git log -1 --oneline
   ```

### Phase 6: Report Result

Display:
```
✓ Committed: {short hash} {commit message first line}

📊 Stats: {files changed}, {insertions}+, {deletions}-

🌿 Branch: {branch-name}
```

## Smart Staging Logic

When unstaged changes exist across multiple areas:

1. **Single logical change:** Stage all related files automatically
2. **Multiple logical changes:** Present options via `AskUserQuestion`:
   ```
   question: "Multiple changes detected. Which to commit first?"
   options:
     - "Module A changes (3 files)"
     - "Module B changes (2 files)"
     - "All changes together"
     - "Let me specify"
   ```

3. **Mixed concerns:** Warn and suggest splitting:
   - "These changes span unrelated modules. Recommend separate commits."

## Quality Checks

Before committing, verify:
- [ ] No `SCRATCHPAD_*.md` or `SESSION_LOG_*` files staged
- [ ] No `console.log` or debug statements (unless intentional)
- [ ] No TODO comments that should be addressed first
- [ ] No secrets, API keys, or sensitive data
- [ ] Changes are complete (no half-finished work)
- [ ] Commit message accurately describes changes

## Error Handling

### Nothing to Commit
If no changes exist:
```
ℹ️ No changes to commit.
   Working tree is clean.
```

### Merge Conflicts
If conflicts exist:
```
⚠️ Cannot commit: merge conflicts present.
   Resolve conflicts first, then commit.
```

### Detached HEAD
If in detached HEAD state:
```
⚠️ Warning: You're in detached HEAD state.
   Consider creating a branch before committing.
```

## Integration with Other Skills

**Called by:**
- `do-work` skill - After completing each scratchpad task (without confirmations under an authorized factory run)
- User directly via natural language

**Calls:**
- `scripts/factory.sh` `authorization` (Phase 0) and `agent` (Phases 0 and 0.5; docs/FACTORY_CLI.md)

**Works with:**
- Project CLAUDE.md - Module emojis and conventions
- Scratchpad - Context for what was being worked on

## Project-Specific Adaptations

The skill reads the project's CLAUDE.md to determine:
- Module names and their emojis
- Commit message conventions (if custom)
- Scope naming patterns

**Example from a project CLAUDE.md:**
```markdown
## Project Modules
- **api** 🌐: REST API endpoints
- **frontend** 🎨: React UI components
- **database** 🗄️: Database layer
```

This skill would then use 🌐 for api changes, 🎨 for frontend changes, etc.

## Best Practices

### ✅ DO:
- Create atomic commits (one logical change)
- Write meaningful commit messages
- Reference issues when applicable
- Stage related files together
- Use project-specific module emojis

### ❌ DON'T:
- Commit unrelated changes together
- Use vague messages like "updates" or "fixes"
- Include debugging code
- Commit secrets or credentials
- Skip the body when context is needed
- Add Claude attribution to commit messages
- Commit SCRATCHPAD_*.md or SESSION_LOG_* files

---

**Version:** 1.2.0
**Last Updated:** 2026-11-16
**Maintained By:** Escapement
**Converted From:** commands/commit.md
**Changelog:**
- v1.2.0: Plain path commits as the agent too, with the `factory agent` identity; as the operator only when no identity is configured, with a notice (#80)
- v1.1.0: Under a matching active factory authorization, commit without confirmations, as the AI agent's identity (#64)
