#!/bin/bash
#
# archive-session-log.sh
#
# PreCompact hook script for Claude Code that archives the session transcript
# before auto-compaction occurs.
#
# Context-path aware: if the project's CLAUDE.md defines a context-path,
# session logs are written to the context directory under the current branch.
# Otherwise, falls back to writing to the project root.
#
# Input (via stdin): JSON with session_id, transcript_path, trigger, hook_event_name
# Output: Creates SESSION_LOG_{N}.md in context dir or project root
# Exit: 0 (always - don't block compaction)
#

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Parse JSON input
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
TRIGGER=$(echo "$INPUT" | jq -r '.trigger // empty')

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
if [ -z "$PROJECT_DIR" ]; then
    echo "Error: CLAUDE_PROJECT_DIR not set" >&2
    exit 0  # Don't block compaction
fi

# Ensure project directory exists
if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: Project directory not found: $PROJECT_DIR" >&2
    exit 0  # Don't block compaction
fi

# Get current branch (if in git repo)
CURRENT_BRANCH=""
if git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    CURRENT_BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "unknown")
fi

# Determine output directory: context-path or project root
OUTPUT_DIR="$PROJECT_DIR"

if [ -f "$PROJECT_DIR/CLAUDE.md" ]; then
    # Extract context-path from CLAUDE.md
    # Looks for: - **context-path**: <path>
    # Uses sed instead of grep -P for portability (BSD/macOS compatibility)
    CONTEXT_PATH=$(sed -n 's/^[[:space:]]*-[[:space:]]*\*\*context-path\*\*:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$PROJECT_DIR/CLAUDE.md" 2>/dev/null | head -1)

    if [ -n "$CONTEXT_PATH" ]; then
        # Expand tilde
        CONTEXT_PATH="${CONTEXT_PATH/#\~/$HOME}"

        # Resolve relative paths against project directory
        if [[ "$CONTEXT_PATH" != /* ]]; then
            CONTEXT_PATH="$PROJECT_DIR/$CONTEXT_PATH"
        fi

        # Normalize the path
        CONTEXT_PATH=$(cd "$PROJECT_DIR" && realpath -m "$CONTEXT_PATH" 2>/dev/null || echo "$CONTEXT_PATH")

        # Use branch subdirectory within context path
        BRANCH_DIR="$CONTEXT_PATH/${CURRENT_BRANCH:-main}"

        if mkdir -p "$BRANCH_DIR" 2>/dev/null; then
            OUTPUT_DIR="$BRANCH_DIR"
            echo "Context path detected: writing to $OUTPUT_DIR" >&2
        else
            echo "Warning: Could not create context directory $BRANCH_DIR, falling back to project root" >&2
        fi
    fi
fi

# Find next session log number
NEXT_NUM=1
while [ -f "$OUTPUT_DIR/SESSION_LOG_${NEXT_NUM}.md" ]; do
    NEXT_NUM=$((NEXT_NUM + 1))
done

OUTPUT_FILE="$OUTPUT_DIR/SESSION_LOG_${NEXT_NUM}.md"

# Get current timestamp
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Get HEAD SHA
HEAD_SHA=""
if git -C "$PROJECT_DIR" rev-parse --git-dir > /dev/null 2>&1; then
    HEAD_SHA=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
fi

# Start building output
{
    echo "# Session Log"
    echo ""
    echo "## Metadata"
    echo ""
    echo "| Field | Value |"
    echo "|-------|-------|"
    echo "| Archived | $TIMESTAMP |"
    echo "| Session ID | $SESSION_ID |"
    echo "| Branch | $CURRENT_BRANCH |"
    echo "| Code SHA | $HEAD_SHA |"
    echo "| Trigger | $TRIGGER (auto-compaction) |"
    echo "| Source | \`$TRANSCRIPT_PATH\` |"
    echo ""
    echo "---"
    echo ""
    echo "## Conversation"
    echo ""

    # Process JSONL transcript
    # Each line is a JSON object with role, content, timestamp, etc.
    while IFS= read -r line; do
        # Skip empty lines
        [ -z "$line" ] && continue

        # Parse JSON line
        TYPE=$(echo "$line" | jq -r '.type // empty')

        case "$TYPE" in
            "user")
                CONTENT=$(echo "$line" | jq -r '.message.content // empty')
                if [ -n "$CONTENT" ]; then
                    echo "### User"
                    echo ""
                    echo "$CONTENT"
                    echo ""
                fi
                ;;
            "assistant")
                CONTENT=$(echo "$line" | jq -r '.message.content // empty')
                if [ -n "$CONTENT" ]; then
                    echo "### Assistant"
                    echo ""
                    # Handle content that might be an array
                    if echo "$CONTENT" | jq -e 'type == "array"' > /dev/null 2>&1; then
                        echo "$CONTENT" | jq -r '.[] | if type == "object" then .text // .content // "" else . end' 2>/dev/null || echo "$CONTENT"
                    else
                        echo "$CONTENT"
                    fi
                    echo ""
                fi
                ;;
            "tool_use"|"tool_result")
                TOOL_NAME=$(echo "$line" | jq -r '.name // .tool_name // "tool"')
                echo "<details>"
                echo "<summary>Tool: $TOOL_NAME</summary>"
                echo ""
                echo "\`\`\`json"
                echo "$line" | jq -r '.input // .result // .content // .' 2>/dev/null | head -100
                echo "\`\`\`"
                echo "</details>"
                echo ""
                ;;
            "summary")
                CONTENT=$(echo "$line" | jq -r '.summary // empty')
                if [ -n "$CONTENT" ]; then
                    echo "### Summary (Previous Compaction)"
                    echo ""
                    echo "$CONTENT"
                    echo ""
                fi
                ;;
            *)
                # Skip unknown types silently
                ;;
        esac
    done < "$TRANSCRIPT_PATH"

    echo ""
    echo "---"
    echo ""
    echo "*Session log archived by Escapement PreCompact hook*"

} > "$OUTPUT_FILE"

echo "Session log archived to: $OUTPUT_FILE" >&2

exit 0
