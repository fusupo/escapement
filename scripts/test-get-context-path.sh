#!/usr/bin/env bash
#
# Tests for get-context-path.sh.
#
# Each fixture in scripts/fixtures/context-path/ is a NAME.md file with
# NAME.out (expected stdout, empty when no setting is found) and NAME.warn
# (expected number of warnings on stderr). The same fixtures are used by
# manifest/test-init.ts and scripts/test-migrate-archives.py.
#
# Usage: bash scripts/test-get-context-path.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
parser="$here/get-context-path.sh"
fixtures="$here/fixtures/context-path"
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

for md in "$fixtures"/*.md; do
  name="$(basename "$md" .md)"
  check "$name" "$(cat "$fixtures/$name.out")" "$(cat "$fixtures/$name.warn")" "$md"
done

check "missing-file" "" 0 "$fixtures/does-not-exist.md"
check "escapement-claude-md" "../escapement-ctx" 0 "$here/../CLAUDE.md"

# Default argument: ./CLAUDE.md in the working directory.
tmp="$(mktemp -d)"
printf '## Escapement Settings\n- **context-path**: ../default-ctx\n' > "$tmp/CLAUDE.md"
out="$(cd "$tmp" && bash "$parser")"
if [[ "$out" == "../default-ctx" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL default-arg: '$out'"; fi
rm -rf "$tmp"

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
