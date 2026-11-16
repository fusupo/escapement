#!/usr/bin/env bash
#
# Tests for hooks/factory-exec-guard.sh, the PreToolUse guard that sends a
# factory run's checks through `factory exec`. The marker is written by
# hand here; manifest/test-factory-guard.ts covers how the runner keeps it.
#
# Usage: bash scripts/test-factory-hook.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook="$here/../hooks/factory-exec-guard.sh"
pass=0
fail=0
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/    /' <<<"$2"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/sub" && git -C "$repo" init -q -b 42-x
marker="$repo/.git/escapement-factory-run.json"
future="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+1H +%Y-%m-%dT%H:%M:%S.000Z)"
past="$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v-1H +%Y-%m-%dT%H:%M:%S.000Z)"
write_marker() {
  printf '{"version": 1, "run_id": "acme-w#42-r1", "worktree_path": "%s", "deadline_at": %s, "commands": ["npm run lint", "npm test"]}\n' "$repo" "$1" > "$marker"
}

# guard <command> [cwd]: prints the exit status, then stderr
guard() {
  local input
  input="$(jq -n --arg c "$1" --arg d "${2:-$repo}" '{hook_event_name: "PreToolUse", tool_name: "Bash", cwd: $d, tool_input: {command: $c}}')"
  local err
  err="$(bash "$hook" <<<"$input" 2>&1 >/dev/null)"
  echo "$?"
  printf '%s' "$err"
}
expect() { # expect <name> <status> <command> [cwd]
  local out status
  out="$(guard "$3" "${4:-$repo}")"
  status="$(head -n1 <<<"$out")"
  if [[ "$status" == "$2" ]]; then ok; else bad "$1" "status=$status for: $3$(tail -n +2 <<<"$out")"; fi
}

# No marker: everything passes, quickly.
expect "no-marker" 0 "npm test"
start=$(date +%s)
for _ in $(seq 20); do guard "npm test" >/dev/null; done
elapsed=$(( $(date +%s) - start ))
if (( elapsed < 10 )); then ok; else bad "no-marker-is-cheap" "20 calls took ${elapsed}s"; fi
expect "outside-a-repo" 0 "npm test" "$tmp"

write_marker "\"$future\""
expect "raw-verify" 2 "npm test"
expect "raw-static" 2 "npm run lint"
expect "with-args" 2 "npm test -- --runInBand"
expect "env-prefix" 2 "CI=1 npm test"
expect "compound" 2 "cd sub && npm test"
expect "piped" 2 "npm test | tail -5"
expect "subshell" 2 "(npm test)"
expect "time" 2 "time npm test"
expect "from-subdir" 2 "npm test" "$repo/sub"
expect "through-factory" 0 "bash \"/x/scripts/factory.sh\" exec 'acme-w#42-r1' -- npm test"
expect "through-factory-piped" 0 "bash /x/scripts/factory.sh exec 'acme-w#42-r1' -- npm test 2>&1 | tail -5"
expect "commit-message" 0 "git commit -m \"run npm test before merging\""
expect "other-npm" 0 "npm install"
expect "prefix-not-word" 0 "npm testing"
expect "echo" 0 "echo npm test"

out="$(guard "npm test")"
if grep -q "factory.sh\" exec 'acme-w#42-r1' -- npm test" <<<"$out" && grep -q "exec-hook: off" <<<"$out"; then ok; else bad "deny-message" "$out"; fi

write_marker "\"$past\""
expect "expired-marker" 0 "npm test"
write_marker "null"
expect "no-deadline" 2 "npm test"
echo '{not json' > "$marker"
expect "malformed-marker" 0 "npm test"
write_marker "\"$future\""
out="$(jq -n --arg d "$repo" '{cwd: $d, tool_input: {command: "npm test"}}' | env PATH=/nonexistent /bin/bash "$hook" 2>&1)"
if [[ $? -eq 0 ]]; then ok; else bad "no-jq-fails-open" "$out"; fi
out="$(echo 'garbage' | bash "$hook" 2>&1)"
if [[ $? -eq 0 ]]; then ok; else bad "bad-input-fails-open" "$out"; fi

# A linked worktree has its own marker; the main checkout's doesn't guard it.
git -C "$repo" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m init
git -C "$repo" worktree add -q -b 43-y "$tmp/linked"
expect "linked-without-marker" 0 "npm test" "$tmp/linked"

# Registered for Bash calls in the plugin's hooks.json.
if jq -e '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.command | endswith("/hooks/factory-exec-guard.sh"))' "$here/../hooks/hooks.json" >/dev/null; then ok; else bad "registered"; fi

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
