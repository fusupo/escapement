---
name: archive-work
description: Archive completed scratchpads and session logs to project history. Invoke when user says "archive this work", "clean up scratchpad", "archive scratchpad", or after PR is merged.
tools:
  - Read
  - Write
  - Edit
  - Bash:mkdir *
  - Bash:mv *
  - Bash:cp *
  - Bash:realpath *
  - Bash:git *
  - Bash:python3 *
  - Bash:bash *
  - Bash:rm *
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

### Phase 1.5: Capture Session Tail

The PreCompact hook only writes session logs at compaction, so the conversation since the last compaction (or the last archive) has no log yet. Save it now so it is archived with this work, not with whichever issue the next compaction happens in. Run this **before** Phase 2 so the new log is found with the others.

1. **Slice the current session's transcript** without moving its cursor yet:
   ```bash
   SLICER="${CLAUDE_PLUGIN_ROOT}/scripts/slice-session-log.sh"
   TRANSCRIPT=$(bash "$SLICER" find "${CLAUDE_CODE_SESSION_ID:-}") &&
     bash "$SLICER" slice "$TRANSCRIPT" . --no-advance
   ```
   - `find` fails (no `CLAUDE_CODE_SESSION_ID`, or no transcript): warn `Session tail not captured: {error}` and go on to Phase 2.
   - `EMPTY`: nothing new since the last log. Go on to Phase 2.
   - Otherwise it prints `FILE=… START=… END=… LINES=…`. Keep `FILE` and `END`.

2. **Check whose conversation it is.** Transcript entries record the git branch they happened on:
   ```bash
   python3 -I - "$FILE" <<'EOF'
   import collections, json, sys
   branches, times = collections.Counter(), []
   for line in open(sys.argv[1], encoding="utf-8"):
       try:
           entry = json.loads(line)
       except json.JSONDecodeError:
           continue
       if entry.get("gitBranch"):
           branches[entry["gitBranch"]] += 1
       if entry.get("timestamp"):
           times.append(entry["timestamp"])
   print(dict(branches), times[0] if times else "-", times[-1] if times else "-")
   EOF
   ```

3. **Include or leave it:**
   - **Every branch is the current branch** (`git branch --show-current`): include it without asking. Run `bash "$SLICER" commit "$TRANSCRIPT" "$END"` and report `Captured session tail: {LINES} lines -> {FILE}`.
   - **Otherwise** (e.g. archiving from `develop` after a merge, or a session that moved on to other work), ask:
     ```
     AskUserQuestion:
       question: "The session since the last log ({LINES} lines, {size}, {first} to {last}) ran on branches {branch: count, ...}. Include it in this archive?"
       header: "Session tail"
       options:
         - label: "Include in this archive"
           description: "Archive it with this work"
         - label: "Leave for the next log"
           description: "Don't archive it now; the next session log picks it up"
     ```
     - **Include:** run `bash "$SLICER" commit "$TRANSCRIPT" "$END"`
     - **Leave:** `rm "$FILE"`. The cursor stays put, so nothing is lost.

The rest of this archive-work run lands in the session's next log.

### Phase 2: Detect Artifacts (Parallel)

**Execute these searches in parallel** for faster detection:

1. **Find Scratchpads:**
   - `Glob: SCRATCHPAD_*.md` in project root
   - Identify issue numbers from filenames

2. **Find Session Logs:**
   - `Glob: SESSION_LOG_*.jsonl` in project root (current format — raw JSONL transcripts)
   - `Glob: SESSION_LOG_*.md` in project root (legacy format — pre-converted markdown)
   - These are created by the PreCompact hook at each compaction, and by Phase 1.5 for the session tail
   - Each covers only the conversation since the previous log, not the whole session
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
        ├── SESSION_LOG_1.md          # Converted from .jsonl during archive
        ├── SESSION_LOG_2.md          # (or legacy .md moved directly)
        └── README.md
```

No timestamp prefix on the branch directory — the branch name is the identifier.
If multiple archives exist for the same branch (rare), add a timestamp suffix to the archive directory.

**In-Repo Mode (no context-path):**

```
docs/dev/cc-archive/
└── {YYYYMMDDHHMM}-{issue-number}-{brief-description}/
    ├── SCRATCHPAD_{issue_number}.md
    ├── SESSION_LOG_1.md (converted or legacy)
    └── README.md (summary)
```

**Note:** The final archive always contains `.md` files only. Any `.jsonl` files are converted to markdown during archiving (see Phase 4).

### Phase 3.5: Convert JSONL Session Logs to Markdown

**For each `SESSION_LOG_*.jsonl` file found in Phase 2**, convert to markdown before archiving.

The conversion uses `scripts/convert-session-log.py` from the Escapement plugin directory (`${CLAUDE_PLUGIN_ROOT}`).

**For each `.jsonl` file:**

```bash
CODE_SHA=$(git rev-parse --short HEAD)
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/convert-session-log.py" \
  SESSION_LOG_{N}.jsonl SESSION_LOG_{N}.md "$CODE_SHA"
rm SESSION_LOG_{N}.jsonl
```

This produces a markdown file with:
- Metadata table (session ID, branch, timestamp, code SHA)
- Conversation sections (`### User` / `### Assistant` / `### Summary`)
- Tool use in collapsible `<details>` blocks
- Thinking blocks and system messages stripped
- Long content truncated to 100 lines

Because each log covers only its own stretch of the session, the metadata Timestamp is when that stretch began (usually the previous compaction), not when the session started.

**The resulting `.md` file** is ready to be moved to the archive directory in Phase 4 (alongside any legacy `.md` session logs).

**Legacy `.md` files:** Session logs already in `.md` format (from before this change) need no conversion — they pass through to Phase 4 directly.

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

   # Move converted session logs from project root (.md only — .jsonl already
   # converted and deleted in Phase 3.5)
   for log in SESSION_LOG_*.md; do
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

### Phase 4.5: Project Lore Retro

Before confirming the archive, perform a retro pass on `PROJECT_LORE.md` — the cumulative, cross-branch record of non-obvious project context. The archive moment is the highest-signal time for this: the work is done, but the mental model is still loaded.

**Lore file location (cumulative, NOT under `{branch}/`):**
- Context mode: `{context-path}/PROJECT_LORE.md`
- In-repo mode: `PROJECT_LORE.md` at project root

**What the lore file captures** (each entry: one line, tagged, with a *why*):
- `[invariant]` — load-bearing constraints that must hold
- `[gotcha]` — surprising behaviors in tools/libs/system
- `[glossary]` — project-specific vocabulary
- `[coupling]` — non-obvious "change X, check Y" relationships
- `[do-not-touch]` — looks refactorable, has hidden constraints

**Inclusion test:** *would a future session waste time, repeat a mistake, or make a wrong choice without this?* If no, skip.

**Out of scope:** what code does (readable from source), what changed (git history), current task state (scratchpad), retrospective narrative ("this was tricky"), full decision records (if still load-bearing, it's an invariant).

**Format bias:** high-signal, grep-able one-liners over narrative. Context is expensive.

#### Steps

1. **Identify scope of work:**
   ```bash
   MERGE_BASE=$(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
   CHANGED_FILES=$(git diff --name-only "$MERGE_BASE" HEAD)
   ```

2. **Reconcile (edit/remove stale entries):**
   If `PROJECT_LORE.md` exists at the resolved path:
   - Read it
   - Identify entries that reference files or domains in `$CHANGED_FILES`
   - Surface those entries to the user as "potentially affected by this work"
   - For each flagged entry, ask the user whether to keep / edit / remove:
     ```
     AskUserQuestion:
       question: "This lore entry may be stale after this work. Action?"
       header: "Reconcile"
       options:
         - "Keep as-is"
         - "Edit (I'll provide replacement text)"
         - "Remove"
     ```
   - Apply user choices. Skip this step if no entries are flagged.

3. **Capture new entries:**
   Ask the user whether the completed work surfaced lore worth capturing:
   ```
   AskUserQuestion:
     question: "Any new project lore from this work?"
     header: "Capture"
     options:
       - "Yes, walk me through categories"
       - "No, skip"
   ```
   If yes, for each category prompt the user for entries, applying the inclusion test. When in doubt, **don't add** — noise is worse than omission.

4. **Write `PROJECT_LORE.md`:**
   Maintain this structure (initialize if newly creating):
   ```markdown
   # Project Lore

   Non-obvious context for future sessions. Each entry: one-line rule, *why*.
   Inclusion test: would a future session waste time, repeat a mistake, or
   make a wrong choice without this?

   ## Invariants
   - rule — *why: reason*

   ## Gotchas
   - rule — *why: reason*

   ## Glossary
   - term — *why: definition/context*

   ## Coupling
   - rule — *why: reason*

   ## Do-not-touch
   - rule — *why: reason*
   ```

5. **First-run nudge (CLAUDE.md reference):**
   If `PROJECT_LORE.md` was **newly created** in this retro, check whether the project's `CLAUDE.md` already references it:
   ```bash
   grep -q "PROJECT_LORE" CLAUDE.md
   ```
   If no match, offer to add a reference so the file auto-loads in future sessions:
   ```
   AskUserQuestion:
     question: "Add @{lore-path}/PROJECT_LORE.md reference to CLAUDE.md so it auto-loads?"
     header: "Auto-load"
     options:
       - "Yes, add reference"
       - "No, I'll handle it manually"
   ```
   If yes, append to CLAUDE.md under an appropriate section (e.g., after "Escapement Settings" or in a "Project Context" section):
   ```markdown
   ## Project Context

   @{relative-path-to-lore-file}
   ```
   - Context mode: `@../myproject-ctx/PROJECT_LORE.md` (or whatever the resolved path is)
   - In-repo mode: `@PROJECT_LORE.md`

   This is a **one-time nudge**, not enforcement — the user retains control.

#### Skip condition

If all of the following are true, skip the retro entirely:
- No scratchpad tasks completed
- No code changes (empty `$CHANGED_FILES`)
- No existing `PROJECT_LORE.md` to reconcile

In that case, there is nothing to reconcile and unlikely genuine lore to capture.

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

3. **Update INDEX.md** (context mode only)

   **Skip this step entirely if `ARCHIVE_MODE=in-repo`.**

   When `ARCHIVE_MODE=context`, maintain a chronological manifest at the context-path root:

   ```
   INDEX_FILE="{context-path}/INDEX.md"
   ```

   **Algorithm:**

   1. Read `INDEX_FILE` with the Read tool (if it exists)
   2. If the file does not exist, initialize it with this header:
      ```markdown
      # Archive Index

      | Archived | Branch | Issue | Status |
      |----------|--------|-------|--------|
      ```
   3. Build a new row from the archive metadata (already available from Phase 2/4):
      ```
      | {YYYY-MM-DD} | {branch} | [#{issue_number}]({issue_github_url}) {issue_title} | {status} |
      ```
      - `{YYYY-MM-DD}`: today's date
      - `{branch}`: the branch being archived (from `git branch --show-current`)
      - `{issue_number}`, `{issue_title}`, `{issue_github_url}`: from the scratchpad
      - `{status}`: the same value used in the archive README (Merged, Completed, or Abandoned)
   4. Append the new row **at the end** of the table so that entries are in chronological order (oldest first, newest last)
   5. Write the full updated content back with the Write tool

   **Example result after two archives:**
   ```markdown
   # Archive Index

   | Archived | Branch | Issue | Status |
   |----------|--------|-------|--------|
   | 2026-02-20 | 43-fix-login-bug | [#43](https://github.com/owner/repo/issues/43) Fix login bug | Merged |
   | 2026-02-25 | 44-refactor-api | [#44](https://github.com/owner/repo/issues/44) Refactor API | Merged |
   ```

4. **Commit in Code Repo:**
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

INDEX.md updated:
   - {context-path}/INDEX.md
   - Added row: {date} | {branch} | #{issue_number} | {status}

Project lore (if changed):
   - {context-path}/PROJECT_LORE.md
   - {N} entries added / {M} reconciled

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

Project lore (if changed):
   - PROJECT_LORE.md
   - {N} entries added / {M} reconciled

{If committed}
Committed: {commit hash}
   - Added: archive directory with scratchpad, session logs, README
   - Removed: SCRATCHPAD_{issue_number}.md from project root
   - Removed: SESSION_LOG_*.md from project root
   - Modified: PROJECT_LORE.md (if changed)
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

**Version:** 2.4.0
**Last Updated:** 2026-10-19
**Maintained By:** Escapement
**Changelog:**
- v2.4.0: Added Phase 1.5 Capture Session Tail — save the conversation since the last session log, with a branch check before including another branch's work (#55)
- v2.3.0: Added Phase 4.5 Project Lore Retro — reconcile + capture non-obvious context (invariants, gotchas, glossary, coupling, do-not-touch) at archive time
- v2.2.1: Extract JSONL→markdown conversion to reusable script (scripts/convert-session-log.py)
- v2.2.0: Maintain INDEX.md manifest at context-path root on archive (#25)
- v2.1.0: Added JSONL→markdown conversion (Phase 3.5) for simplified PreCompact hook (#27)
- v2.0.0: Added context-path support for external archive directories
- v1.3.0: Added parallel execution for artifact detection
- v1.2.0: Added SESSION_LOG_*.md detection and archiving (from PreCompact hook)
- v1.1.0: Added timestamp prefix for chronological sorting; use git mv for proper tracking
- v1.0.0: Initial conversion from commands/archive-dev.md
