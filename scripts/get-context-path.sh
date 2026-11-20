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
# and one surrounding pair of quotes or backticks removed. Without
# --absolute the value is printed as written.
#
# With --absolute (what skills use), the setting is read from the main
# checkout's CLAUDE.md and printed as an absolute path resolved against the
# main checkout, so every worktree of a repository, wherever it lives, finds
# the same context directory (#88). The main checkout is the parent of
# `git rev-parse --git-common-dir`; in a bare repository's worktree it is
# the worktree itself, and outside git it is the current directory. This
# matches the factory runner (manifest/factory/context.ts, resolveContextPath).
# "." and ".." are collapsed without touching the filesystem, so the
# directory need not exist. A leading "~" is not expanded.
#
# An unfenced context-path line outside the section is ignored, with a
# warning on stderr.
#
# The same rules are implemented in manifest/init.ts (parseContextPath) and
# scripts/migrate-archives.py (parse_context_path). Keep them in sync; the
# cases in scripts/fixtures/context-path.md describe the expected behavior.
#
# Usage:
#   get-context-path.sh [CLAUDE.md]              (default: ./CLAUDE.md)
#   get-context-path.sh --absolute [CLAUDE.md]   (default: the main
#       checkout's CLAUDE.md; an explicit file is resolved against the
#       main checkout of the repository it lives in)
#
# Exit status is 0 unless the file exists but cannot be read.
#

set -euo pipefail

absolute=0
file=""
for arg in "$@"; do
  case "$arg" in
    --absolute) absolute=1 ;;
    -*) echo "get-context-path: unknown option: $arg" >&2; exit 2 ;;
    *)
      [[ -z "$file" ]] || { echo "get-context-path: more than one file given" >&2; exit 2; }
      file="$arg"
      ;;
  esac
done

# The main checkout of the repository that holds directory $1, as a
# physical path (see the header).
main_root() {
  local dir="$1" common top
  if common="$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null)" && [[ -n "$common" ]]; then
    # git may print the common dir relative to $dir (from the main checkout).
    if common="$(cd "$dir" && cd "$common" && pwd -P)"; then
      if [[ "$(basename "$common")" == ".git" ]]; then
        dirname "$common"
        return
      fi
      if top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" && [[ -n "$top" ]]; then
        (cd "$top" && pwd -P)
        return
      fi
    fi
  fi
  (cd "$dir" && pwd -P)
}

# Collapse "." and ".." in an absolute path, lexically.
normalize() {
  local part
  local -a parts out=()
  IFS=/ read -r -a parts <<< "$1"
  for part in "${parts[@]}"; do
    case "$part" in
      "" | .) ;;
      ..) [[ ${#out[@]} -eq 0 ]] || unset "out[$((${#out[@]} - 1))]" ;;
      *) out+=("$part") ;;
    esac
  done
  if [[ ${#out[@]} -eq 0 ]]; then echo /; else printf '/%s' "${out[@]}"; echo; fi
}

if [[ $absolute -eq 1 ]]; then
  if [[ -n "$file" ]]; then
    root="$(main_root "$(dirname "$file")")"
  else
    root="$(main_root "$PWD")"
    file="$root/CLAUDE.md"
  fi
else
  file="${file:-CLAUDE.md}"
fi
[[ -f "$file" ]] || exit 0

value="$(awk -v q="'" -v file="$file" '
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
' "$file")"

[[ -n "$value" ]] || exit 0
if [[ $absolute -eq 0 ]]; then
  printf '%s\n' "$value"
elif [[ "$value" == /* ]]; then
  normalize "$value"
else
  normalize "$root/$value"
fi
