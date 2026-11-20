#!/usr/bin/env bash
#
# Tests for get-context-path.sh --absolute from linked worktrees (#88).
#
# Runs the worktree cases at the top of scripts/fixtures/context-path.md
# (format described there) against a real repository: the main checkout in
# one temporary directory, and a linked worktree nested in another, so it
# sits outside the repository's parent directory. Each case must give the
# same directory from the worktree, a subdirectory of it, the main checkout
# and a subdirectory of that. The same cases run against the runner
# (manifest/test-context-worktree.ts) and migrate-archives.py
# (scripts/test-context-worktree.py).
#
# Usage: bash scripts/test-context-worktree.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parser="$here/get-context-path.sh"
cases="$here/fixtures/context-path.md"
pass=0
fail=0

ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }

# Run the parser with --absolute from directory $2 and compare with $3.
check() {
  local name="$1" dir="$2" expected="$3" out status
  out="$(cd "$dir" && bash "$parser" --absolute 2>/dev/null)"
  status=$?
  if [[ $status -eq 0 && "$out" == "$expected" ]]; then ok; else bad "$name from $dir: status=$status out='$out' (want '$expected')"; fi
}

g() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

tmp="$(cd "$(mktemp -d)" && pwd -P)"
far="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp" "$far"' EXIT

# The repository: its committed CLAUDE.md (what the worktree gets) sets
# ../wrong-ctx; each case then writes the main checkout's own copy.
main="$tmp/repo/main"
parent="$tmp/repo"
mkdir -p "$main"
g init -q -b main "$main"
printf '## Escapement Settings\n\n- **context-path**: ../wrong-ctx\n' > "$main/CLAUDE.md"
g -C "$main" add CLAUDE.md
g -C "$main" commit -q -m init
mkdir -p "$main/sub/deeper"
wt="$far/a/b/wt"
g -C "$main" worktree add -q -b wt-branch "$wt" 2>/dev/null || { echo "FAIL: git worktree add"; exit 1; }
mkdir -p "$wt/sub"

case "$wt" in "$parent"/*) echo "FAIL: the worktree must be outside the repository's parent"; exit 1 ;; esac

# Split the worktree cases: each body goes to $tmp/cases/NAME.md and one
# line per case (NAME|EXPECT) to $tmp/cases/index. Stops at the first
# parser case.
mkdir "$tmp/cases"
awk -v dir="$tmp/cases" '
  /^=== case: / { exit }
  /^=== worktree: / {
    split(substr($0, 5), f, / \| /)
    name = f[1]; sub(/^worktree: */, "", name)
    expect = f[2]; sub(/^expect: ?/, "", expect); sub(/ +$/, "", expect)
    out = dir "/" name ".md"
    printf "" > out
    print name "|" expect > (dir "/index")
    next
  }
  out != "" { print > out }
' "$cases"

n="$(wc -l < "$tmp/cases/index" 2>/dev/null || echo 0)"
[[ "$n" -ge 5 ]] || { echo "FAIL: only $n worktree cases parsed from $cases"; exit 1; }

while IFS="|" read -r name expect; do
  cp "$tmp/cases/$name.md" "$main/CLAUDE.md"
  expected="${expect//\{main\}/$main}"
  expected="${expected//\{parent\}/$parent}"
  check "$name (worktree)" "$wt" "$expected"
  check "$name (worktree subdirectory)" "$wt/sub" "$expected"
  check "$name (main checkout)" "$main" "$expected"
  check "$name (main checkout subdirectory)" "$main/sub/deeper" "$expected"
done < "$tmp/cases/index"

# An explicit file is resolved against the main checkout of its repository.
printf '## Escapement Settings\n\n- **context-path**: ../explicit-ctx\n' > "$main/CLAUDE.md"
out="$(cd / && bash "$parser" --absolute "$main/CLAUDE.md")"
[[ "$out" == "$parent/explicit-ctx" ]] && ok || bad "explicit file: '$out'"

# Without --absolute nothing changes: the value as written, from ./CLAUDE.md.
out="$(cd "$wt" && bash "$parser")"
[[ "$out" == "../wrong-ctx" ]] && ok || bad "no flag in the worktree: '$out'"

# A worktree of a bare repository has no main checkout: it stands in.
g clone -q --bare "$main" "$tmp/bare.git" 2>/dev/null
g -C "$tmp/bare.git" worktree add -q "$far/bare-wt" main 2>/dev/null || bad "bare worktree add"
check "bare repository worktree" "$far/bare-wt" "$far/wrong-ctx"

# Outside git the current directory stands in.
mkdir "$tmp/plain"
printf '## Escapement Settings\n\n- **context-path**: ../plain-ctx\n' > "$tmp/plain/CLAUDE.md"
check "outside git" "$tmp/plain" "$tmp/plain-ctx"

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
