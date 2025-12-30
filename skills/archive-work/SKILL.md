---
name: archive-work
description: Archive completed scratchpads and session logs to project history. Invoke when user says "archive this work", "clean up scratchpad", "archive scratchpad", or after PR is merged.
tools:
  - Read
  - Write
  - Bash:mkdir *
  - Bash:mv *
  - Bash:git *
  - Glob
  - AskUserQuestion
  - Skill
---

# Archive Work Skill

## Purpose

Archive completed scratchpads and development artifacts to maintain clean project roots while preserving work history for future reference. This skill organizes completed work into a structured archive.

## Natural Language Triggers

This skill activates when the user says things like:
- "Archive this work"
- "Clean up the scratchpad"
- "Archive scratchpad"
- "Move scratchpad to archive"
- "We're done, archive everything"
- After PR merge: "PR merged, let's clean up"

## Workflow Execution

### Phase 1: Detect Artifacts

1. **Find Scratchpads:**
   - Look for `SCRATCHPAD_*.md` in project root
   - Identify issue numbers from filenames

2. **Find Related Files:**
   - Session logs (if any)
   - Related temporary files
   - Claude Code conversation exports

3. **Verify Completion:**
   - Check if scratchpad tasks are all complete
   - Check if PR was created/merged
   - Warn if work appears incomplete

### Phase 2: Determine Archive Location

**Default Structure:**
```
docs/dev/cc-archive/
└── {issue-number}-{brief-description}/
    ├── SCRATCHPAD_{issue_number}.md
    ├── session-log.md (if exists)
    └── README.md (summary)
```

**Check Project Conventions:**
- Read CLAUDE.md for custom archive location
- Check if `docs/dev/cc-archive/` exists
- Create directory structure if needed

### Phase 3: Prepare Archive

1. **Create Archive Directory:**
   ```bash
   mkdir -p docs/dev/cc-archive/{issue-number}-{description}
   ```

2. **Generate Archive Summary:**
   Create `README.md` in archive folder:
   ```markdown
   # Issue #{issue_number} - {title}

   **Archived:** {date}
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
   ```bash
   mv SCRATCHPAD_{issue_number}.md docs/dev/cc-archive/{dir}/
   ```

### Phase 4: Confirm with User

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

### Phase 5: Execute Archive

1. **Move Files:**
   - Move scratchpad to archive directory
   - Move any related session logs
   - Create summary README

2. **Commit Archive:**
   If user opted to commit:
   ```
   Skill: commit-changes

   # Commit message will be:
   # 📚🗃️ chore(docs): Archive work for issue #{issue_number}
   #
   # Completed work archived to docs/dev/cc-archive/
   # PR: #{pr_number}
   ```

### Phase 6: Report Result

```
✓ Work archived successfully!

📁 Archive location:
   docs/dev/cc-archive/{issue-number}-{description}/

📄 Files archived:
   - SCRATCHPAD_{issue_number}.md
   - README.md (summary generated)

🗑️ Cleaned up:
   - Removed scratchpad from project root

{If committed}
📝 Committed: {commit hash}
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
    - "Yes, use docs/dev/cc-archive/"
    - "Specify custom location"
```

## Error Handling

### No Scratchpad Found
```
ℹ️ No scratchpad found to archive.
   Looking for: SCRATCHPAD_*.md in project root
```

### Work Incomplete
```
⚠️ Scratchpad has incomplete tasks:
   - {unchecked task 1}
   - {unchecked task 2}

   Archive anyway?
   1. Yes, archive incomplete work
   2. No, continue working first
```

### Archive Directory Exists
```
⚠️ Archive already exists for issue #{number}

   Options:
   1. Overwrite existing archive
   2. Create numbered version (archive-2/)
   3. Cancel
```

### No PR Created
```
ℹ️ No PR found for this work.

   Archive anyway?
   1. Yes, archive without PR reference
   2. No, create PR first
```

## Integration with Other Skills

**Invoked by:**
- `work-session` skill - After completing all tasks
- User directly after PR is merged

**Invokes:**
- `commit-changes` skill - To commit archive

**Reads from:**
- Scratchpad - Content to archive
- Git history - PR information

## Archive Structure Best Practices

### Recommended Directory Layout
```
docs/
└── dev/
    └── cc-archive/
        ├── 42-add-authentication/
        │   ├── SCRATCHPAD_42.md
        │   └── README.md
        ├── 43-fix-login-bug/
        │   ├── SCRATCHPAD_43.md
        │   └── README.md
        └── 44-refactor-api/
            ├── SCRATCHPAD_44.md
            ├── session-log.md
            └── README.md
```

### Archive Naming Convention
`{issue-number}-{slugified-description}/`

Examples:
- `42-add-user-authentication/`
- `123-fix-payment-bug/`
- `7-initial-project-setup/`

## Best Practices

### ✅ DO:
- Archive after PR is merged
- Include summary README
- Preserve decision history
- Use consistent archive location
- Commit archives to repo

### ❌ DON'T:
- Archive incomplete work without noting it
- Delete without archiving (lose history)
- Mix archives from different projects
- Skip the summary README
- Leave scratchpads in project root long-term

---

**Version:** 1.0.0
**Last Updated:** 2025-12-29
**Maintained By:** Muleteer
**Converted From:** commands/archive-dev.md
