# Session Archiving

Automatically archive Claude Code session logs before auto-compaction occurs.

## Overview

Claude Code has an auto-compaction feature that triggers when the conversation context approaches token limits. When this happens, conversation history is condensed, potentially losing valuable implementation details, decisions, and troubleshooting context.

This hook-based system:
1. Detects when auto-compaction is about to occur
2. Copies the raw session transcript (JSONL) to your project root
3. Allows compaction to proceed normally
4. The `archive-work` skill later converts JSONL to readable markdown during archiving

## Quick Setup

Escapement registers the hook automatically via `hooks/hooks.json` when loaded as a plugin:

```bash
claude --plugin-dir /path/to/escapement
```

The hook fires for both auto and manual compaction — no manual settings.json configuration needed.

## How It Works

### Trigger Condition

The hook triggers for **both auto and manual compaction**:

- **Auto-compaction**: When context window fills up, transcript is archived automatically
- **Manual `/compact`**: Run `/compact` anytime to capture the session and compact

This gives you flexibility to capture session logs when finishing work, even before the context window is full.

### What the Hook Does

The PreCompact hook is intentionally minimal (~20 lines of functional code):

1. Reads `transcript_path` and `session_id` from the hook input JSON
2. Copies the raw JSONL transcript to `SESSION_LOG_{N}.jsonl` in the project root
3. Exits — no parsing, no formatting, no conversion

The hook's job is **preservation** (survive compaction), not **presentation**.

### In-Progress Format

During active work, raw JSONL session logs sit alongside your scratchpad:

```
your-project/
├── SESSION_LOG_1.jsonl    # Raw transcript (first compaction)
├── SESSION_LOG_2.jsonl    # Raw transcript (second compaction)
├── SCRATCHPAD_42.md       # Your scratchpad
└── ...
```

Incremental numbering ensures no overwrites.

### Conversion to Markdown

When you run the `archive-work` skill (typically after PR merge), it:

1. Detects `SESSION_LOG_*.jsonl` files in the project root
2. Claude reads the JSONL and renders proper markdown — with metadata tables, user/assistant sections, and tool use in `<details>` blocks
3. Writes `SESSION_LOG_{N}.md` to the archive directory
4. Deletes the `.jsonl` files from the project root

This produces higher-fidelity markdown than the previous bash/jq approach, and Claude handles format changes gracefully.

### Final Archive Location

When you use the `archive-work` skill after completing work, session logs are converted and moved:

**With context-path configured:**
```
{context-path}/
├── INDEX.md                          # Chronological archive manifest
└── {branch}/archive/
    ├── SCRATCHPAD_{issue_number}.md
    ├── SESSION_LOG_1.md              # Converted from JSONL
    ├── SESSION_LOG_2.md
    └── README.md
```

**Without context-path (in-repo):**
```
docs/dev/cc-archive/{YYYYMMDDHHMM}-{issue-number}-{description}/
├── SCRATCHPAD_{issue_number}.md
├── SESSION_LOG_1.md
└── README.md
```

## Configuration Options

### Hook Matcher

The hook is configured in `hooks/hooks.json` with matchers for both compaction types:

| Value | Description |
|-------|-------------|
| `"manual"` | Only manual /compact commands |
| `"auto"` | Only auto-compaction |

**Note:** Unlike other Claude Code hooks, PreCompact does NOT support `"*"` wildcard. To capture both auto and manual compaction, you must include **two separate matcher entries**. The default `hooks.json` includes both.

### Timeout

The `timeout` field (in seconds) controls how long to wait for the script to complete. Default: 60 seconds.

## Troubleshooting

### Session log not created

1. **Check script is executable:**
   ```bash
   ls -la /path/to/escapement/hooks/archive-session-log.sh
   ```
   Should show `-rwxr-xr-x` permissions.

2. **Check jq is installed:**
   ```bash
   which jq
   ```
   Install with: `sudo apt install jq` or `brew install jq`
   (jq is only used for parsing the 2-field hook input JSON — not for transcript processing.)

3. **Check hook configuration:**
   Verify the plugin is loaded and `hooks/hooks.json` has the correct configuration.

4. **Check trigger type:**
   Both `auto` and `manual` compaction should trigger the hook if both matchers are configured.

### Script errors

Run the script manually to test:

```bash
echo '{"transcript_path": "/path/to/test.jsonl", "session_id": "test", "trigger": "auto"}' | \
  CLAUDE_PROJECT_DIR=/path/to/project \
  /path/to/escapement/hooks/archive-session-log.sh
```

You should see a `SESSION_LOG_1.jsonl` file appear in the project directory — an exact copy of the input transcript.

## Environment Variables

The hook script uses these environment variables (provided by Claude Code):

| Variable | Description |
|----------|-------------|
| `CLAUDE_PROJECT_DIR` | Current project directory path |

## Integration with Archive-Work

The `archive-work` skill handles the full lifecycle:

1. During active work, raw JSONL session logs accumulate in project root
2. When you invoke `archive-work`, it:
   - Converts `SESSION_LOG_*.jsonl` to markdown (Phase 3.5)
   - Moves converted `.md` files to the archive directory
   - Deletes `.jsonl` files from project root
   - Handles legacy `.md` session logs (from before this change) directly
3. Creates a README.md summarizing the archived work

## Dependencies

- **jq**: JSON processor (for parsing 2-field hook input only — not used for transcript processing)
- **bash**: Shell interpreter
- **git**: For detecting current branch (optional, graceful fallback)

## Security Notes

- The script only reads from the transcript path provided by Claude Code
- Writes only to your project directory
- Never sends data externally
- Always exits 0 to avoid blocking your workflow
