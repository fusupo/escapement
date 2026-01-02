# Session Archiving

Automatically archive Claude Code session logs before auto-compaction occurs.

## Overview

Claude Code has an auto-compaction feature that triggers when the conversation context approaches token limits. When this happens, conversation history is condensed, potentially losing valuable implementation details, decisions, and troubleshooting context.

This hook-based system:
1. Detects when auto-compaction is about to occur
2. Archives the full chat log to your project
3. Allows compaction to proceed normally

## Quick Setup

### 1. Run the Escapement installer

```bash
~/.escapement/install.sh
```

This ensures the archive script is executable.

### 2. Add hook to your settings

Add the following to your Claude Code settings file:

**Global (all projects):** `~/.claude/settings.json`
**Per-project:** `.claude/settings.json`

```json
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "manual",
        "hooks": [
          {
            "type": "command",
            "command": "~/.escapement/scripts/archive-session-log.sh",
            "timeout": 60
          }
        ]
      },
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "~/.escapement/scripts/archive-session-log.sh",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

A template is available at: `~/.escapement/templates/hooks-config.json`

## How It Works

### Trigger Condition

The hook triggers for **both auto and manual compaction**:

- **Auto-compaction**: When context window fills up, session is archived automatically
- **Manual `/compact`**: Run `/compact` anytime to capture the session and compact

This gives you flexibility to capture session logs when finishing work, even before the context window is full.

### Archive Location

Session logs are saved to your **project root**:

```
your-project/
├── SESSION_LOG_1.md    # First session log
├── SESSION_LOG_2.md    # Second session log
├── SCRATCHPAD_42.md    # Your scratchpad
└── ...
```

Incremental numbering ensures no overwrites.

### Archive Format

Each session log is a readable Markdown file:

```markdown
# Session Log

## Metadata

| Field | Value |
|-------|-------|
| Archived | 2025-12-29T14:30:00Z |
| Session ID | abc123 |
| Branch | feature/my-feature |
| Trigger | auto (auto-compaction) |
| Source | `~/.claude/projects/.../session.jsonl` |

---

## Conversation

### User

How do I implement the auth feature?

### Assistant

Let me help you with that...

...
```

### Final Archive Location

When you use the `archive-work` skill after completing work, session logs are moved along with the scratchpad to:

```
docs/dev/cc-archive/{YYYYMMDDHHMM}-{issue-number}-{description}/
├── SCRATCHPAD_{issue_number}.md
├── SESSION_LOG_1.md
├── SESSION_LOG_2.md
└── README.md
```

The timestamp prefix is on the directory (for chronological sorting), not individual files.

## Configuration Options

### Hook Matcher

The `matcher` field controls when the hook fires:

| Value | Description |
|-------|-------------|
| `"manual"` | Only manual /compact commands |
| `"auto"` | Only auto-compaction |

**Note:** Unlike other Claude Code hooks, PreCompact does NOT support `"*"` wildcard. To capture both auto and manual compaction, you must include **two separate matcher entries** (as shown in the configuration above). The default template includes both.

### Timeout

The `timeout` field (in seconds) controls how long to wait for the script to complete. Default: 60 seconds.

## Troubleshooting

### Session log not created

1. **Check script is executable:**
   ```bash
   ls -la ~/.escapement/scripts/archive-session-log.sh
   ```
   Should show `-rwxr-xr-x` permissions.

2. **Check jq is installed:**
   ```bash
   which jq
   ```
   Install with: `sudo apt install jq` or `brew install jq`

3. **Check hook configuration:**
   Verify your settings.json has the correct hook configuration.

4. **Check trigger type:**
   The hook only fires on `auto` compaction by default. Manual `/compact` won't trigger it.

### Script errors

Run the script manually to test:

```bash
echo '{"transcript_path": "/path/to/test.jsonl", "session_id": "test", "trigger": "auto"}' | \
  CLAUDE_PROJECT_DIR=/path/to/project \
  ~/.escapement/scripts/archive-session-log.sh
```

### Large session logs

Very long sessions may produce large log files. The script processes all content by default. If you need to limit size, you can modify the script to truncate at a certain point.

## Environment Variables

The hook script uses these environment variables (provided by Claude Code):

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_DIR` | Current project directory path |

## Integration with Archive-Work

The `archive-work` skill automatically handles session logs:

1. During active work, session logs accumulate in project root
2. When you invoke `archive-work`, it moves:
   - Your scratchpad (with timestamp prefix)
   - All SESSION_LOG_*.md files (with timestamp prefix)
3. Creates a README.md summarizing the archived work

## Dependencies

- **jq**: JSON processor (for parsing hook input and transcript)
- **bash**: Shell interpreter
- **git**: For detecting current branch (optional, graceful fallback)

## Security Notes

- The script only reads from the transcript path provided by Claude Code
- Writes only to your project directory
- Never sends data externally
- Always exits 0 to avoid blocking your workflow
