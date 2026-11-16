#!/usr/bin/env bash
#
# Tests for get-context-path.sh.
#
# The cases live in scripts/fixtures/context-path.md (format described at
# the top of that file) and are shared with manifest/test-init.ts and
# scripts/test-migrate-archives.py.
#
# Usage: bash scripts/test-get-context-path.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parser="$here/get-context-path.sh"
cases="$here/fixtures/context-path.md"
pass=0
fail=0

check() {
  local name="$1" expected="$2" expected_warn="$3" file="$4"
  local err out warn status
  err="$(mktemp)"
  out="$(bash "$parser" "$file" 2>"$err")"
  status=$?
  warn="$(grep -c 'warning' "$err" || true)"
  if [[ $status -eq 0 && "$out" == "$expected" && "$warn" == "$expected_warn" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL $name: status=$status out='$out' (want '$expected') warnings=$warn (want $expected_warn)"
    sed 's/^/    stderr: /' "$err"
  fi
  rm -f "$err"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Split the cases file: each case body goes to $tmp/NAME.md, and one line
# per case (NAME|EXPECT|WARNINGS) goes to $tmp/index. "|" rather than a
# tab, because read merges adjacent tabs and would drop an empty EXPECT.
awk -v dir="$tmp" '
  /^=== case: / {
    split(substr($0, 5), f, / \| /)
    name = f[1]; sub(/^case: */, "", name)
    expect = f[2]; sub(/^expect: */, "", expect); sub(/ +$/, "", expect)
    warn = f[3]; sub(/^warnings: */, "", warn)
    out = dir "/" name ".md"
    printf "" > out
    print name "|" expect "|" warn > (dir "/index")
    next
  }
  out != "" { print > out }
' "$cases"

[[ -s "$tmp/index" ]] || { echo "FAIL: no cases parsed from $cases"; exit 1; }
while IFS="|" read -r name expect warn; do
  check "$name" "$expect" "$warn" "$tmp/$name.md"
done < "$tmp/index"

# Whitespace-sensitive cases, built here so editors can't strip them.
printf '## Escapement Settings\r\n\r\n- **context-path**: ../crlf-ctx\r\n' > "$tmp/crlf.md"
check "crlf" "../crlf-ctx" 0 "$tmp/crlf.md"
printf '## Escapement Settings\n\n- **context-path**: ../trailing-ctx   \t\n' > "$tmp/trailing.md"
check "trailing-whitespace" "../trailing-ctx" 0 "$tmp/trailing.md"

check "missing-file" "" 0 "$tmp/does-not-exist.md"
check "escapement-claude-md" "../escapement-ctx" 0 "$here/../CLAUDE.md"

# Default argument: ./CLAUDE.md in the working directory.
mkdir "$tmp/default"
printf '## Escapement Settings\n- **context-path**: ../default-ctx\n' > "$tmp/default/CLAUDE.md"
out="$(cd "$tmp/default" && bash "$parser")"
if [[ "$out" == "../default-ctx" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL default-arg: '$out'"; fi

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
