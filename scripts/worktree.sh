#!/usr/bin/env bash
#
# worktree.sh
#
# Creates, lists and removes a repository's worktrees in one place, out of
# sight, instead of next to the repository (#88):
#
#   ${XDG_DATA_HOME:-~/.local/share}/escapement/worktrees/{owner}-{repo}/{name}
#
# {owner}-{repo} comes from the main checkout's origin URL, or is the main
# checkout's directory name when there is no origin. Skills and procedures
# create worktrees with this script, never with a hand-written path. It works
# from any checkout or worktree of the repository, and a worktree anywhere
# finds the project's context directory (get-context-path.sh --absolute).
#
# Usage:
#   worktree.sh path <name>
#       Print the worktree's path.
#   worktree.sh add <name> [<commit-ish>] [-b <branch>] [--detach]
#       git worktree add at that path (without -b or --detach, git creates a
#       branch named <name>, or checks out <commit-ish>). Prints the path as
#       the last line of stdout. An existing worktree there is reported and
#       left as it is (exit 0). When the new worktree is Escapement itself,
#       also runs `npm ci --prefix <path>/manifest`; if that fails the
#       worktree stays and the exit status is 1.
#   worktree.sh list
#       git worktree list, with "*" marking the worktrees this script manages.
#   worktree.sh remove <name> [--force]
#       git worktree remove (git refuses a dirty worktree without --force).
#       The branch is kept.
#
# Options may come anywhere among the arguments. A name may not be empty,
# ".", start with "/" or contain ".."; a "/" in it becomes "-" (feat/x ->
# feat-x). git's own output goes to stderr.
#

set -euo pipefail

die() { echo "worktree: $*" >&2; exit 1; }

usage() {
  sed -n '/^# Usage:/,/^# feat-x/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The main checkout of the current repository, as a physical path: the git
# common dir's parent, or the worktree itself in a bare repository. Same
# rule as get-context-path.sh --absolute.
main_root() {
  local common top
  common="$(git rev-parse --git-common-dir)"
  common="$(cd "$common" && pwd -P)"
  if [[ "$(basename "$common")" == ".git" ]]; then
    dirname "$common"
  else
    top="$(git rev-parse --show-toplevel)"
    (cd "$top" && pwd -P)
  fi
}

# {owner}-{repo} from origin, like the runner's repoName, else the
# directory name.
repo_slug() {
  local main="$1" url re='[:/]([^/:]+)/([^/]+)$'
  url="$(git -C "$main" config --get remote.origin.url 2>/dev/null || true)"
  url="${url%/}"
  url="${url%.git}"
  if [[ -n "$url" && "$url" =~ $re ]]; then
    echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}"
  else
    basename "$main"
  fi
}

check_name() {
  local name="$1"
  [[ -n "$name" ]] || die "missing name"
  [[ "$name" != /* ]] || die "a name is not a path: $name"
  [[ "$name" != *..* ]] || die "a name may not contain '..': $name"
  name="${name//\//-}"
  [[ "$name" != "." ]] || die "a name may not be '.'"
  echo "$name"
}

# Is $1 a worktree of this repository?
is_our_worktree() {
  local path="$1" theirs
  [[ -d "$path" ]] || return 1
  theirs="$(git -C "$path" rev-parse --git-common-dir 2>/dev/null)" || return 1
  theirs="$(cd "$path" && cd "$theirs" && pwd -P)" || return 1
  [[ "$theirs" == "$common_dir" ]]
}

is_escapement() {
  local path="$1"
  [[ -f "$path/manifest/package.json" ]] &&
    grep -Eq '"name"[[:space:]]*:[[:space:]]*"escapement"' "$path/.claude-plugin/plugin.json" 2>/dev/null
}

cmd=""
detach=0
force=0
branch=""
positional=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --detach) detach=1 ;;
    --force | -f) force=1 ;;
    -b)
      [[ $# -ge 2 ]] || die "-b needs a branch name"
      branch="$2"
      shift
      ;;
    -h | --help) usage ;;
    -*) die "unknown option: $1" ;;
    *)
      if [[ -z "$cmd" ]]; then cmd="$1"; else positional+=("$1"); fi
      ;;
  esac
  shift
done
[[ -n "$cmd" ]] || usage

git rev-parse --git-dir > /dev/null 2>&1 || die "not inside a git repository: $PWD"
main="$(main_root)"
common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
[[ "$data" == /* ]] || data="$PWD/$data"
base="$data/escapement/worktrees/$(repo_slug "$main")"

case "$cmd" in
  path)
    [[ ${#positional[@]} -eq 1 ]] || usage
    name="$(check_name "${positional[0]}")"
    echo "$base/$name"
    ;;

  add)
    [[ ${#positional[@]} -ge 1 && ${#positional[@]} -le 2 ]] || usage
    [[ $detach -eq 0 || -z "$branch" ]] || die "--detach and -b don't go together"
    name="$(check_name "${positional[0]}")"
    path="$base/$name"
    if [[ -e "$path" ]]; then
      is_our_worktree "$path" || die "$path exists and is not a worktree of this repository"
      echo "worktree: already exists: $path" >&2
      echo "$path"
      exit 0
    fi
    args=(worktree add)
    [[ $detach -eq 0 ]] || args+=(--detach)
    [[ -z "$branch" ]] || args+=(-b "$branch")
    args+=("$path")
    [[ ${#positional[@]} -lt 2 ]] || args+=("${positional[1]}")
    mkdir -p "$base"
    git "${args[@]}" >&2
    if is_escapement "$path"; then
      echo "worktree: installing the runner's dependencies: npm ci --prefix $path/manifest" >&2
      npm ci --prefix "$path/manifest" >&2 ||
        die "npm ci failed in $path/manifest; the worktree is in place, run it again there"
    fi
    echo "$path"
    ;;

  list)
    [[ ${#positional[@]} -eq 0 ]] || usage
    base_phys="$base"
    [[ -d "$base" ]] && base_phys="$(cd "$base" && pwd -P)"
    git worktree list --porcelain | awk -v base="$base/" -v phys="$base_phys/" '
      function flush() {
        if (p != "") printf "%s %s  %s\n", ((index(p, base) == 1 || index(p, phys) == 1) ? "*" : " "), p, b
        p = ""
      }
      /^worktree / { flush(); p = substr($0, 10); b = "(detached)"; next }
      /^branch / { b = substr($0, 8); sub(/^refs\/heads\//, "", b); next }
      /^bare$/ { b = "(bare)"; next }
      END { flush() }
    '
    ;;

  remove)
    [[ ${#positional[@]} -eq 1 ]] || usage
    name="$(check_name "${positional[0]}")"
    path="$base/$name"
    is_our_worktree "$path" || die "no worktree of this repository at $path"
    args=(worktree remove)
    [[ $force -eq 0 ]] || args+=(--force)
    git "${args[@]}" "$path" >&2
    ;;

  *) usage ;;
esac
