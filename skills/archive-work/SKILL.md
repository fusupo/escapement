---
name: archive-work
description: Archive completed scratchpads and session logs to project history. Invoke when user says "archive this work", "clean up scratchpad", "archive scratchpad", or after PR is merged.
tools:
  - Read
  - Write
  - Bash:mkdir *
  - Bash:mv *
  - Bash:cp *
  - Bash:realpath *
  - Bash:git *
  - Glob
  - Grep
  - AskUserQuestion
  - Skill
---

# Archive Work Skill

## Purpose

Archive completed scratchpads and development artifacts to maintain clean project roots while preserving work history for future reference. This skill organizes completed work into a structured archive.

**Context-path aware:** If the project's CLAUDE.md defines a `context-path`, archives are written to the external context directory instead of `docs/dev/cc-archive/`. This keeps the code repo clean of development artifacts.

## Natural Language Triggers

This skill activates when the user says things like:
- "Archive this work"
- "Clean up the scratchpad"
- "Archive scratchpad"
- "Move scratchpad to archive"
- "We're done, archive everything"
- After PR merge: "PR merged, let's clean up"

## Workflow Execution

### Phase 1: Detect Context Path

**Read project's CLAUDE.md** and check for Escapement Settings:

```markdown
## Escapement Settings

- **context-path**: ../myproject-ctx
```

**If context-path is set:**
- Resolve the path relative to project root
- Determine current branch name
- Target directory: `{context-path}/{branch}/archive/`
- Create the directory structure if it doesn't exist
- Set `ARCHIVE_MODE=context`

**If context-path is NOT set:**
- Fall back to `docs/dev/cc-archive/` (existing behavior)
- Set `ARCHIVE_MODE=in-repo`

### Phase 2: Detect Artifacts (Parallel)

**Execute these searches in parallel** for faster detection:

1. **Find Scratchpads:**
   - `Glob: SCRATCHPAD_*.md` in project root
   - Identify issue numbers from filenames

2. **Find Session Logs:**
   - `Glob: SESSION_LOG_*.md` in project root
   - **Also check context directory** if context-path is set:
     `Glob: {context-path}/{branch}/SESSION_LOG_*.md`
   - These are created by the PreCompact hook before auto-compaction
   - Associate with scratchpad (same issue context)

3. **Find Other Related Files:**
   - Related temporary files
   - Claude Code conversation exports

4. **Check Git Status:**
   - Current branch for context
   - Recent commits for PR detection
   - HEAD SHA for linking

**After parallel detection, verify completion:**
- Check if scratchpad tasks are all complete
- Check if PR was created/merged
- Warn if work appears incomplete

### Phase 3: Determine Archive Location

**Context Mode (context-path set):**

```
{context-path}/
└── {branch-name}/
    └── archive/
        ├── SCRATCHPAD_{issue_number}.md
        ├── SESSION_LOG_1.md
        ├── SESSION_LOG_2.md
        └── README.md
```

No timestamp prefix on the branch directory — the branch name is the identifier.
If multiple archives exist for the same branch (rare), add a timestamp suffix to the archive directory.

**In-Repo Mode (no context-path):**

```
docs/dev/cc-archive/
└── {YYYYMMDDHHMM}-{issue-number}-{brief-description}/
    ├── SCRATCHPAD_{issue_number}.md
    ├── SESSION_LOG_1.md (if exists)
    └── README.md (summary)
```

### Phase 4: Prepare Archive

1. **Create Archive Directory:**

   **Context mode:**
   ```bash
   CONTEXT_PATH=$(sed -n 's/^[[:space:]]*-[[:space:]]*\*\*context-path\*\*:[[:space:]]*\([^[:space:]]*\).*/\1/p' CLAUDE.md | head -1)
   BRANCH=$(git branch --show-current)
   ARCHIVE_DIR="$CONTEXT_PATH/$BRANCH/archive"
   mkdir -p "$ARCHIVE_DIR"
   ```

   **In-repo mode:**
   ```bash
   TIMESTAMP=$(date +%Y%m%d%H%M)
   ARCHIVE_DIR="docs/dev/cc-archive/${TIMESTAMP}-{issue-number}-{description}"
   mkdir -p "$ARCHIVE_DIR"
   ```

2. **Generate Archive Summary:**
   Create `README.md` in archive folder:
   ```markdown
   # Issue #{issue_number} - {title}

   **Archived:** {date}
   **Branch:** {branch_name}
   **Code SHA:** {HEAD sha at time of archive}
   **PR:** #{pr_number} (if applicable)
   **Status:** {Completed/Merged/Abandoned}

   ## Summary
   {Brief description of what was accomplished}

   ## Key Decisions
   {Extract from scratchpad Decisions Made section}

   ## Files Changed
   {List of files that were modified}

   ## Lessons Learned
   {Any notable insights from Work Log}
   ```

3. **Move Files:**

   **Context mode:**
   ```bash
   # Copy scratchpad to context directory FIRST (before git rm deletes it)
   cp SCRATCHPAD_{issue_number}.md "$ARCHIVE_DIR/"

   # Then remove scratchpad from code repo tracking
   git rm SCRATCHPAD_{issue_number}.md

   # Move session logs from project root (if any landed here)
   for log in SESSION_LOG_*.md; do
     if [ -f "$log" ]; then
       mv "$log" "$ARCHIVE_DIR/"
     fi
   done

   # Move session logs from context branch dir (hook may have written them there)
   BRANCH_DIR="$CONTEXT_PATH/$BRANCH"
   for log in "$BRANCH_DIR"/SESSION_LOG_*.md; do
     if [ -f "$log" ]; then
       mv "$log" "$ARCHIVE_DIR/"
     fi
   done
   ```

   **In-repo mode (existing behavior):**
   ```bash
   git mv SCRATCHPAD_{issue_number}.md "$ARCHIVE_DIR/"

   for log in SESSION_LOG_*.md; do
     if [ -f "$log" ]; then
       mv "$log" "$ARCHIVE_DIR/"
     fi
   done
   git add "$ARCHIVE_DIR"/SESSION_LOG_*.md 2>/dev/null || true
   ```

   **Important (context mode):** Copy the scratchpad BEFORE `git rm` — `git rm` deletes
   the working tree copy. The scratchpad content is preserved in the context directory.
   The context directory is NOT a git repo managed by this skill — the operator handles
   that separately.

### Phase 5: Confirm with User

```
AskUserQuestion:
  question: "Ready to archive this work?"
  header: "Archive"
  options:
    - "Yes, archive and commit"
      description: "Move files to archive and create commit"
    - "Archive without commit"
      description: "Move files but don't commit yet"
    - "Show me what will be archived"
      description: "Preview the archive operation"
    - "Cancel"
      description: "Keep scratchpad in current location"
```

**Context mode additional info:**
```
Archive destination: {resolved context path}/{branch}/archive/
   (outside code repo — context directory)

Code repo changes:
   - SCRATCHPAD_{issue_number}.md will be removed (git rm)

Context directory changes:
   - Scratchpad, session logs, and summary will be written
   - You'll need to commit the context directory separately if it's git-tracked
```

### Phase 6: Execute Archive

1. **Move Files** (per Phase 4 instructions based on mode)

2. **Write README.md** to archive directory

3. **Commit in Code Repo:**
   If user opted to commit:

   **Context mode:**
   ```
   Skill: commit-changes

   # Commit message will be:
   # 📚🗃️ chore(docs): Archive work for issue #{issue_number}
   #
   # Scratchpad archived to context directory
   # PR: #{pr_number}
   ```

   The commit only contains the removal of the scratchpad from project root.
   No archive files are added to the code repo.

   **In-repo mode:**
   ```
   Skill: commit-changes

   # Commit message will be:
   # 📚🗃️ chore(docs): Archive work for issue #{issue_number}
   #
   # Completed work archived to docs/dev/cc-archive/
   # PR: #{pr_number}
   ```

### Phase 7: Report Result

**Context mode:**
```
Work archived successfully.

Context archive:
   {context-path}/{branch}/archive/

Files archived (to context directory):
   - SCRATCHPAD_{issue_number}.md
   - SESSION_LOG_*.md (if any existed)
   - README.md (summary generated)

Code repo cleanup:
   - Removed SCRATCHPAD_{issue_number}.md (git rm)
   - Removed SESSION_LOG_*.md from project root

{If committed}
Code repo committed: {commit hash}
   - Removed: SCRATCHPAD_{issue_number}.md

Note: context directory changes are not auto-committed.
   If your context directory is git-tracked, commit separately:
   cd {context-path} && git add -A && git commit -m "Archive {branch} work"
```

**In-repo mode:**
```
Work archived successfully.

Archive location:
   docs/dev/cc-archive/{YYYYMMDDHHMM}-{issue-number}-{description}/

Files archived:
   - SCRATCHPAD_{issue_number}.md
   - SESSION_LOG_*.md (if any existed)
   - README.md (summary generated)

Cleaned up:
   - Removed scratchpad from project root (tracked via git mv)
   - Removed session logs from project root

{If committed}
Committed: {commit hash}
   - Added: archive directory with scratchpad, session logs, README
   - Removed: SCRATCHPAD_{issue_number}.md from project root
   - Removed: SESSION_LOG_*.md from project root
```

## Archive Options

### Option 1: Full Archive (Default)
- Move scratchpad to archive
- Generate summary README
- Commit the archive

### Option 2: Delete Only
If user prefers not to keep history:
```
AskUserQuestion:
  question: "How to handle the scratchpad?"
  options:
    - "Archive (keep history)"
    - "Delete (no history)"
    - "Keep in place"
```

### Option 3: Custom Location
Allow user to specify different archive location:
```
AskUserQuestion:
  question: "Archive to default location?"
  options:
    - "Yes, use {detected location}"
    - "Specify custom location"
```

## Error Handling

### No Scratchpad Found
```
No scratchpad found to archive.
   Looking for: SCRATCHPAD_*.md in project root
```

### Work Incomplete
```
Scratchpad has incomplete tasks:
   - {unchecked task 1}
   - {unchecked task 2}

   Archive anyway?
   1. Yes, archive incomplete work
   2. No, continue working first
```

### Context Path Not Found
```
Context path configured but directory not found:
   {context-path}

   Options:
   1. Create it now
   2. Fall back to in-repo archive
   3. Cancel
```

### Archive Directory Exists
```
Archive already exists for this branch
   {context-path}/{branch}/archive/

   Options:
   1. Merge into existing archive
   2. Create timestamped subdirectory
   3. Cancel
```

### No PR Created
```
No PR found for this work.

   Archive anyway?
   1. Yes, archive without PR reference
   2. No, create PR first
```

## Integration with Other Skills

**Invoked by:**
- `do-work` skill - After completing all tasks
- User directly after PR is merged

**Invokes:**
- `commit-changes` skill - To commit archive

**Reads from:**
- Scratchpad - Content to archive
- Git history - PR information
- CLAUDE.md - Context path setting

## Best Practices

### DO:
- Archive after PR is merged
- Include summary README
- Preserve decision history
- Use consistent archive location
- Commit code repo changes (scratchpad removal)
- Remember to commit context directory separately if git-tracked
- Use `git rm` for scratchpads in context mode (clean code repo history)
- Copy scratchpad to context dir BEFORE running git rm

### DON'T:
- Archive incomplete work without noting it
- Delete without archiving (lose history)
- Mix archives from different projects in one context directory
- Skip the summary README
- Leave scratchpads in project root long-term
- Assume the context directory auto-commits (it doesn't)
- Run `git rm` before copying the file (it deletes the working copy)

---

**Version:** 2.0.0
**Last Updated:** 2026-02-13
**Maintained By:** Escapement
**Changelog:**
- v2.0.0: Added context-path support for external archive directories
- v1.3.0: Added parallel execution for artifact detection
- v1.2.0: Added SESSION_LOG_*.md detection and archiving (from PreCompact hook)
- v1.1.0: Added timestamp prefix for chronological sorting; use git mv for proper tracking
- v1.0.0: Initial conversion from commands/archive-dev.md
