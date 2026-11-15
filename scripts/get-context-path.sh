#!/usr/bin/env bash
#
# get-context-path.sh
#
# Prints the project's context-path setting from CLAUDE.md, or nothing when
# the setting is absent (callers then fall back to in-repo mode).
#
# Only the first "## Escapement Settings" section counts, up to the next "#"
# or "##" heading ("###" subheadings stay inside it). Lines inside fenced
# code blocks (``` or ~~~) are ignored everywhere, so documentation examples
# never match. The setting line looks like:
#
#   - **context-path**: ../myproject-ctx
#
# The value is everything after the colon, with trailing whitespace trimmed
# and one surrounding pair of quotes or backticks removed. The value is
# printed as written; callers resolve it relative to the project root.
#
# An unfenced context-path line outside the section is ignored, with a
# warning on stderr.
#
# The same rules are implemented in manifest/init.ts (parseContextPath) and
# scripts/migrate-archives.py (parse_context_path). Keep them in sync; the
# fixtures in scripts/test-get-context-path.sh describe the expected behavior.
#
# Usage:
#   get-context-path.sh [CLAUDE.md]     (default: ./CLAUDE.md)
#
# Exit status is 0 unless the file exists but cannot be read.
#

set -euo pipefail

file="${1:-CLAUDE.md}"
[[ -f "$file" ]] || exit 0

awk -v q="'" -v file="$file" '
function strip_quotes(s,   a, b) {
  if (length(s) < 2) return s
  a = substr(s, 1, 1); b = substr(s, length(s), 1)
  if (a == b && (a == "\"" || a == q || a == "`")) return substr(s, 2, length(s) - 2)
  return s
}
{
  line = $0
  sub(/\r$/, "", line)

  # Inside a fence: look only for the closing fence (same character, at
  # least as long as the opening one, nothing else on the line).
  if (fence != "") {
    if (line ~ /^[ \t]*(`+|~+)[ \t]*$/) {
      m = line; gsub(/[ \t]/, "", m)
      if (substr(m, 1, 1) == substr(fence, 1, 1) && length(m) >= length(fence)) fence = ""
    }
    next
  }
  if (match(line, /^[ \t]*(```+|~~~+)/)) {
    fence = substr(line, RSTART, RLENGTH); gsub(/[ \t]/, "", fence)
    next
  }

  if (line ~ /^##?[ \t]/) {
    if (!seen_section && line ~ /^##[ \t]+Escapement Settings[ \t]*$/) {
      in_section = 1; seen_section = 1
    } else {
      in_section = 0
    }
    next
  }

  if (line ~ /^[ \t]*[-*][ \t]+\*\*context-path\*\*:/) {
    if (in_section) {
      if (!found) {
        v = line
        sub(/^[ \t]*[-*][ \t]+\*\*context-path\*\*:[ \t]*/, "", v)
        sub(/[ \t]+$/, "", v)
        value = strip_quotes(v); found = 1
      }
    } else {
      printf "get-context-path: warning: %s:%d: context-path outside \"## Escapement Settings\" is ignored\n", file, NR > "/dev/stderr"
    }
  }
}
END { if (found && value != "") print value }
' "$file"
