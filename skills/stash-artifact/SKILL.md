---
name: stash-artifact
description: Save ad hoc scripts, notes, or other artifacts to the project's context directory (outside the code repo). Invoke when user says "stash this", "save this script", "keep this outside the repo", "save to context", "stash artifact", or when user has a script or note they want preserved but not committed.
tools:
  - Read
  - Write
  - Bash:mkdir *
  - Bash:cp *
  - Bash:realpath *
  - Bash:git *
  - Glob
  - Grep
  - AskUserQuestion
---

# Stash Artifact Skill

## Purpose

Save development artifacts (ad hoc scripts, research notes, scratch files, debug helpers) to the project's context directory so they're preserved without polluting the code repo.

This is for things that are useful but shouldn't be committed: one-off migration scripts, debug helpers, API exploration scripts, research notes, design alternatives, etc.

**Requires context-path** to be configured in the project's CLAUDE.md. If not configured, the skill will offer to set it up.

## Natural Language Triggers

This skill activates when the user says things like:
- "Stash this script"
- "Save this outside the repo"
- "Keep this in context"
- "Save to context"
- "Stash this artifact"
- "I don't want to commit this but want to keep it"
- "Save this for later"
- "Put this in the context directory"

## Workflow Execution

### Phase 1: Resolve Context Path

1. **Read CLAUDE.md** for `context-path` setting:
   ```bash
   # Portable across GNU and BSD (macOS)
   sed -n 's/^[[:space:]]*-[[:space:]]*\*\*context-path\*\*:[[:space:]]*\([^[:space:]]*\).*/\1/p' CLAUDE.md | head -1
   ```

2. **If context-path NOT configured:**
   ```
   AskUserQuestion:
     question: "No context-path configured. Where should artifacts be saved?"
     header: "Context Path"
     options:
       - "Set up ../$(basename $PWD)-ctx"
         description: "Create sibling context directory with default name"
       - "Specify custom path"
         description: "Choose a different location"
       - "Cancel"
         description: "Don't save artifact"
   ```

   If user chooses to set up:
   - Create the directory
   - **Suggest** (but don't auto-edit) adding to CLAUDE.md:
     ```
     Add this to your CLAUDE.md under Escapement Settings:

     ## Escapement Settings

     - **context-path**: ../{project-name}-ctx
     ```

3. **If context-path configured:**
   - Resolve relative to project root
   - Determine current branch
   - Target: `{context-path}/{branch}/`

### Phase 2: Determine Artifact Type

Classify what's being stashed:

| Input | Type | Destination |
|-------|------|-------------|
| A script file or code block | `scripts/` | `{branch}/scripts/{filename}` |
| A note, research, or text | `notes/` | `{branch}/notes/{filename}` |
| An exported/generated file | `artifacts/` | `{branch}/artifacts/{filename}` |
| Unclear | Ask user | -- |

**If type is ambiguous:**
```
AskUserQuestion:
  question: "What kind of artifact is this?"
  header: "Type"
  options:
    - "Script" description: "Code, shell script, helper"
    - "Note" description: "Research, design notes, text"
    - "Other" description: "Generated file, export, etc."
```

### Phase 3: Determine Source

The artifact can come from several places:

1. **A file in the project** (user says "stash scripts/debug-auth.sh"):
   - Read the file
   - Use its filename as default name

2. **Code in the conversation** (user says "stash that script you just wrote"):
   - Extract the most recent code block from conversation
   - Ask for a filename if not obvious

3. **User provides content** (user says "save this note: ..."):
   - Use the provided content
   - Ask for a filename

### Phase 4: Write Artifact

1. **Create target directory:**
   ```bash
   CONTEXT_PATH=$(sed -n 's/^[[:space:]]*-[[:space:]]*\*\*context-path\*\*:[[:space:]]*\([^[:space:]]*\).*/\1/p' CLAUDE.md | head -1)
   BRANCH=$(git branch --show-current)
   TYPE="scripts"  # or notes, artifacts
   TARGET_DIR="$CONTEXT_PATH/$BRANCH/$TYPE"
   mkdir -p "$TARGET_DIR"
   ```

2. **Add frontmatter** (for markdown files / notes):
   ```markdown
   ---
   repo: {owner/repo}
   branch: {current branch}
   code_sha: {HEAD short sha}
   date: {ISO timestamp}
   issue: {issue number if known}
   ---
   ```

3. **Write or copy the file:**
   ```bash
   # If copying from project
   cp "$SOURCE_FILE" "$TARGET_DIR/$FILENAME"

   # If writing new content
   # Write via Write tool to $TARGET_DIR/$FILENAME
   ```

4. **Make scripts executable:**
   ```bash
   if [ "$TYPE" = "scripts" ]; then
     chmod +x "$TARGET_DIR/$FILENAME"
   fi
   ```

### Phase 5: Report

```
Artifact stashed.

Location: {context-path}/{branch}/{type}/{filename}

Metadata:
   Branch: {branch}
   Code SHA: {sha}
   Type: {script/note/artifact}

This file is outside the code repo.
   It won't appear in code search or git status.
```

## Examples

### Stash an ad hoc script
```
User: "stash this migration script, I don't want it in the repo"

-> Copies to ../myproject-ctx/42-add-auth/scripts/migrate-legacy-users.sh
-> Adds execute permission
-> Reports location
```

### Stash a research note
```
User: "save a note about the API design options we discussed"

-> Creates ../myproject-ctx/42-add-auth/notes/api-design-options.md
-> Includes frontmatter with branch/SHA
-> Reports location
```

### Stash from conversation
```
User: "that debug script you just wrote, stash it"

-> Extracts last code block from conversation
-> Asks for filename: "What should I name this? (e.g. debug-token-refresh.sh)"
-> Writes to ../myproject-ctx/42-add-auth/scripts/debug-token-refresh.sh
```

## Error Handling

### Context Path Not Found
```
Context path configured but directory not found: {path}

   Create it now?
   1. Yes, create directory
   2. Cancel
```

### No Branch Detected
```
Not on a git branch (detached HEAD or not a git repo).

   Save to 'untracked/' instead?
   1. Yes, save to untracked/
   2. Specify a directory name
   3. Cancel
```

### File Already Exists
```
File already exists: {path}

   Options:
   1. Overwrite
   2. Save with timestamp suffix
   3. Cancel
```

## Integration with Other Skills

**Standalone skill** -- not invoked by other skills, only by user.

**Related to:**
- `archive-work` -- uses the same context-path configuration
- Session log hook -- writes to the same context directory structure

**Reads from:**
- CLAUDE.md -- context-path setting
- Git -- current branch, HEAD SHA

## Best Practices

### DO:
- Use descriptive filenames
- Include context (what branch, what issue, why)
- Stash scripts you might need again
- Stash research notes during exploration
- Clean up stashed artifacts when they become irrelevant

### DON'T:
- Stash things that should be committed (tests, configs, etc.)
- Use this as a substitute for proper version control
- Let the context directory become a dumping ground without organization

---

**Version:** 1.0.0
**Last Updated:** 2026-02-13
**Maintained By:** Escapement
**Changelog:**
- v1.0.0: Initial skill for context-path artifact stashing
