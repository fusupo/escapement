#!/bin/bash
#
# slice-session-log.sh
#
# Writes the part of a Claude Code session transcript that no earlier session
# log covers to the next free SESSION_LOG_{N}.jsonl. A per-session cursor (the
# last transcript line already written) keeps successive logs contiguous and
# non-overlapping. Without a valid cursor, the slice starts at the last
# compact_boundary, or at line 1 if the session has never compacted.
#
# Used by hooks/archive-session-log.sh (PreCompact) and the archive-work skill.
#
# Usage:
#   slice-session-log.sh find SESSION_ID
#       Print the session's transcript path. Exit 1 if there is none.
#   slice-session-log.sh slice TRANSCRIPT OUTDIR [--no-advance]
#       Write the unarchived lines to OUTDIR/SESSION_LOG_{N}.jsonl and print
#       "FILE=… START=… END=… LINES=…", or "EMPTY" if there is nothing new.
#       Advances the cursor to END unless --no-advance is given.
#   slice-session-log.sh commit TRANSCRIPT END
#       Set the cursor to END (to accept a --no-advance slice).
#
# On failure: exit 1 with a message on stderr, no log file left behind, and
# the cursor unchanged.
#
# Cursors: ${XDG_STATE_HOME:-~/.local/state}/escapement/session-cursors/{session_id}
#

set -euo pipefail

CURSOR_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/escapement/session-cursors"

die() {
    echo "slice-session-log: $*" >&2
    exit 1
}

cursor_file() {
    echo "$CURSOR_DIR/$(basename "$1" .jsonl)"
}

# Print the cursor for a transcript of $2 lines, or nothing if it is missing
# or invalid (e.g. points past the end of a rewritten transcript)
read_cursor() {
    local file cursor
    file=$(cursor_file "$1")
    [ -r "$file" ] || return 0
    cursor=$(head -n 1 "$file")
    if [[ "$cursor" =~ ^[0-9]+$ ]] && [ "$cursor" -le "$2" ]; then
        echo "$cursor"
    fi
}

write_cursor() {
    local file
    file=$(cursor_file "$1")
    mkdir -p "$CURSOR_DIR" &&
        echo "$2" > "$file.tmp.$$" &&
        mv "$file.tmp.$$" "$file"
}

cmd_find() {
    local id="${1:-}" match="" f
    [[ "$id" =~ ^[0-9a-fA-F-]{36}$ ]] || die "invalid session id: '$id'"
    # Newest match, in case the same session id shows up under two projects
    for f in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$id".jsonl; do
        [ -f "$f" ] || continue
        if [ -z "$match" ] || [ "$f" -nt "$match" ]; then
            match=$f
        fi
    done
    [ -n "$match" ] || die "no transcript found for session $id"
    echo "$match"
}

cmd_slice() {
    local transcript="${1:-}" outdir="${2:-}" advance=1
    local end cursor start n=1 output
    [ "${3:-}" = "--no-advance" ] && advance=0
    [ -f "$transcript" ] || die "transcript not found: '$transcript'"
    [ -d "$outdir" ] || die "output directory not found: '$outdir'"

    # Snapshot the end, since the transcript keeps growing. wc -l counts only
    # complete lines, so a partial last line waits for the next slice.
    end=$(wc -l < "$transcript" | tr -d ' ')
    cursor=$(read_cursor "$transcript" "$end")
    if [ -n "$cursor" ]; then
        start=$((cursor + 1))
    else
        # '|| true': grep exits 1 when the session has never compacted
        start=$({ head -n "$end" "$transcript" | grep -n -F '"subtype":"compact_boundary"' || true; } |
            tail -n 1 | cut -d: -f1)
        start=${start:-1}
    fi

    if [ "$start" -gt "$end" ]; then
        echo "EMPTY"
        return 0
    fi

    # Skip numbers taken by converted .md logs too, so conversion can't clobber them
    while [ -e "$outdir/SESSION_LOG_${n}.jsonl" ] || [ -e "$outdir/SESSION_LOG_${n}.md" ]; do
        n=$((n + 1))
    done
    output="$outdir/SESSION_LOG_${n}.jsonl"

    if ! head -n "$end" "$transcript" | tail -n +"$start" > "$output"; then
        rm -f "$output"
        die "failed to write $output"
    fi

    # The log is already written, so a failed cursor update only risks a
    # duplicate in the next log, never a loss
    if [ "$advance" -eq 1 ]; then
        write_cursor "$transcript" "$end" || echo "slice-session-log: warning: cursor not updated" >&2
    fi

    echo "FILE=$output START=$start END=$end LINES=$((end - start + 1))"
}

cmd_commit() {
    local transcript="${1:-}" end="${2:-}"
    [ -f "$transcript" ] || die "transcript not found: '$transcript'"
    [[ "$end" =~ ^[0-9]+$ ]] || die "invalid line number: '$end'"
    write_cursor "$transcript" "$end" || die "failed to write cursor"
}

case "${1:-}" in
    find) shift; cmd_find "$@" ;;
    slice) shift; cmd_slice "$@" ;;
    commit) shift; cmd_commit "$@" ;;
    *) die "usage: $(basename "$0") find SESSION_ID | slice TRANSCRIPT OUTDIR [--no-advance] | commit TRANSCRIPT END" ;;
esac
