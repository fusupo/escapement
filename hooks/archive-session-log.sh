#!/bin/bash
#
# archive-session-log.sh
#
# PreCompact hook script for Claude Code that archives the raw session transcript
# before compaction occurs. Writes only the conversation since the previous
# session log (see scripts/slice-session-log.sh), so a long session doesn't
# repeat itself in every log. Markdown conversion is deferred to the
# archive-work skill, where Claude can render it natively with higher fidelity.
#
# Input (via stdin): JSON with session_id, transcript_path, trigger, hook_event_name
# Output: Creates SESSION_LOG_{N}.jsonl in project root
# Exit: 0 (always - don't block compaction)
#

set -euo pipefail

SLICER="$(dirname "${BASH_SOURCE[0]}")/../scripts/slice-session-log.sh"

# Read hook input from stdin
INPUT=$(cat)

# Parse JSON input (minimal jq — extract only what we need)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Validate required fields
if [ -z "$TRANSCRIPT_PATH" ] || [ -z "$SESSION_ID" ]; then
    echo "Error: Missing transcript_path or session_id" >&2
    exit 0  # Don't block compaction
fi

# Expand tilde in path
TRANSCRIPT_PATH="${TRANSCRIPT_PATH/#\~/$HOME}"

# Check transcript exists
if [ ! -f "$TRANSCRIPT_PATH" ]; then
    echo "Error: Transcript file not found: $TRANSCRIPT_PATH" >&2
    exit 0  # Don't block compaction
fi

# Get project directory
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: CLAUDE_PROJECT_DIR not set or not found" >&2
    exit 0  # Don't block compaction
fi

# Write the conversation since the previous session log
if RESULT=$(bash "$SLICER" slice "$TRANSCRIPT_PATH" "$PROJECT_DIR"); then
    echo "Session log: $RESULT" >&2
    exit 0
fi

# The slicer failed and wrote nothing, so copy the whole transcript rather than lose it
NEXT_NUM=1
while [ -f "$PROJECT_DIR/SESSION_LOG_${NEXT_NUM}.jsonl" ] || [ -f "$PROJECT_DIR/SESSION_LOG_${NEXT_NUM}.md" ]; do
    NEXT_NUM=$((NEXT_NUM + 1))
done

OUTPUT_FILE="$PROJECT_DIR/SESSION_LOG_${NEXT_NUM}.jsonl"

cp "$TRANSCRIPT_PATH" "$OUTPUT_FILE"

echo "Session log archived to: $OUTPUT_FILE (full copy)" >&2

exit 0
