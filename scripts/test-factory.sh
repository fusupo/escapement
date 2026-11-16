#!/usr/bin/env bash
#
# End-to-end tests for factory.sh: the wrapper, the CLI's --json contract
# and its exit statuses. Every run uses a temporary repository and
# ESCAPEMENT_MANIFEST_DIR, so the real manifest database is never opened.
#
# Usage: bash scripts/test-factory.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wrapper="$here/factory.sh"
pass=0
fail=0

ok()   { pass=$((pass + 1)); }
bad()  { fail=$((fail + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/    /' <<<"$2"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export ESCAPEMENT_MANIFEST_DIR="$tmp/data"

# A project with no context-path, so artifacts go in .escapement/, and a
# short command-timeout so exec's default timeout comes from settings.
project="$tmp/project"
mkdir -p "$project"
(
  cd "$project" &&
    git init -q -b 5-thing &&
    echo test > README.md &&
    printf '## Escapement Settings\n\n- **command-timeout**: 2s\n' > CLAUDE.md &&
    git add -A &&
    git -c user.name=t -c user.email=t@example.invalid commit -q -m init
)
cat > "$project/../contract.json" <<'JSON'
{"version": 1, "run_id": "#5-r1", "risk_tier_proposed": "standard",
 "criteria": [{"id": "AC-1", "text": "It works",
   "evidence": [{"id": "AC-1.e1", "type": "test", "kind": "new_behavior", "selector": "t.ts::works"}]}]}
JSON
echo '{"version": 1, "run_id": "#5-r1", "criteria": []}' > "$project/../bad-contract.json"
other="$tmp/other"
mkdir -p "$other"

f() { (cd "${CWD:-$project}" && bash "$wrapper" "$@"); }

# --check and usage
if f --check >/dev/null 2>&1; then ok; else bad "check-installed"; fi
f >/dev/null 2>&1
if [[ $? -eq 1 ]]; then ok; else bad "no-command-exits-1"; fi

# start --json: one JSON object on stdout
out="$(f --json start '#5')"
if [[ "$(jq -r '.ok and .result.run_id == "#5-r1" and .result.state == "planned"' <<<"$out")" == true ]]; then ok; else bad "start-json" "$out"; fi
art="$(jq -r .result.artifact_dir <<<"$out")"
if [[ "$art" == "$project/.escapement/runs/5-thing/#5-r1" && -d "$art" ]]; then ok; else bad "artifact-dir-in-repo" "$art"; fi
if [[ -z "$(git -C "$project" status --porcelain)" ]]; then ok; else bad "tree-stays-clean" "$(git -C "$project" status --porcelain)"; fi

# an invalid contract is rejected with every problem listed
out="$(f --json approve '#5-r1' --contract ../bad-contract.json)"
status=$?
if [[ $status -eq 1 && "$(jq -r '.error.code == "bad_contract" and (.error.message | contains("risk_tier_proposed") and contains("/criteria"))' <<<"$out")" == true ]]; then ok; else bad "approve-bad-contract" "status=$status out=$out"; fi

# approve with a contract path relative to the cwd
out="$(f --json approve '#5-r1' --contract ../contract.json --run-budget 1h)"
if [[ "$(jq -r '.ok and .result.run.state == "approved" and (.result.authorization.authorizes | index("commit") != null)' <<<"$out")" == true ]]; then ok; else bad "approve-json" "$out"; fi

# exec (text mode): streams output, exits with the command's status
out="$(f exec '#5-r1' -- sh -c 'echo hello; exit 3' 2>/dev/null)"
status=$?
if [[ $status -eq 3 && "$out" == "hello" ]]; then ok; else bad "exec-text-exit-status" "status=$status out=$out"; fi

# exec --json: stdout is only the JSON object; the command's output is in the log
out="$(f --json exec '#5-r1' -- sh -c 'echo hello; exit 3')"
status=$?
if [[ $status -eq 3 && "$(jq -r '.ok and .result.outcome == "fail" and .result.exit_code == 3' <<<"$out")" == true ]]; then ok; else bad "exec-json" "status=$status out=$out"; fi
if grep -q hello "$(jq -r .result.log_path <<<"$out")"; then ok; else bad "exec-json-log"; fi

# --json after -- belongs to the command, not the CLI
out="$(f exec '#5-r1' -- echo --json 2>/dev/null)"
if [[ "$out" == "--json" ]]; then ok; else bad "json-after-separator" "$out"; fi

# timeout: the runner kills the command and exits 124
f --json exec --timeout 1s '#5-r1' -- sleep 10 >/dev/null
if [[ $? -eq 124 ]]; then ok; else bad "exec-timeout-124"; fi

# without --timeout, exec uses the project's command-timeout setting (2s)
start=$SECONDS
f --json exec '#5-r1' -- sleep 10 >/dev/null
status=$?
if [[ $status -eq 124 && $((SECONDS - start)) -lt 8 ]]; then ok; else bad "exec-timeout-from-settings" "status=$status"; fi

# status from another directory, with --project-root for start elsewhere
out="$(CWD="$other" f --json status)"
if [[ "$(jq -r '.ok and (.result.runs | map(.run_id) == ["#5-r1"])' <<<"$out")" == true ]]; then ok; else bad "status-list" "$out"; fi
out="$(CWD="$other" f --json status '#5-r1')"
if [[ "$(jq -r '.ok and .result.run.state == "implementing" and .result.authorization.status == "active"' <<<"$out")" == true ]]; then ok; else bad "status-one" "$out"; fi
out="$(CWD="$other" f --json start --project-root "$project" '#6' 2>&1)"
if [[ "$(jq -r '.ok == false and .error.code == "run_exists"' <<<"$out")" == true ]]; then ok; else bad "project-root-from-elsewhere" "$out"; fi

# resume
out="$(f --json resume '#5-r1')"
if [[ "$(jq -r '.ok and (.result.actions | length) == 0' <<<"$out")" == true ]]; then ok; else bad "resume-json" "$out"; fi

# revoke, then exec is blocked: exit 2 and kind "blocked"
out="$(f --json revoke '#5-r1')"
if [[ "$(jq -r '.ok and .result.authorization.status == "revoked"' <<<"$out")" == true ]]; then ok; else bad "revoke-json" "$out"; fi
out="$(f --json exec '#5-r1' -- true)"
status=$?
if [[ $status -eq 2 && "$(jq -r '.ok == false and .error.kind == "blocked" and .error.code == "not_authorized"' <<<"$out")" == true ]]; then ok; else bad "blocked-exit-2" "status=$status out=$out"; fi

# errors: exit 1 with kind "error"
out="$(f --json status 'no-such-run')"
status=$?
if [[ $status -eq 1 && "$(jq -r '.error.code' <<<"$out")" == "no_such_run" ]]; then ok; else bad "error-exit-1" "status=$status out=$out"; fi
out="$(f --json frobnicate)"
if [[ $? -eq 1 && "$(jq -r '.error.code' <<<"$out")" == "usage" ]]; then ok; else bad "unknown-command" "$out"; fi
err="$(f approve '#5-r1' 2>&1 >/dev/null)"
if [[ "$err" == *"missing --contract"* && "$err" == *"Usage: factory"* ]]; then ok; else bad "usage-text" "$err"; fi

# check: readiness without a run or a database. The project sets no static
# or verify command, and the contract has test evidence but no test-results.
out="$(ESCAPEMENT_MANIFEST_DIR="$tmp/nodb" f --json check --contract ../contract.json)"
status=$?
if [[ $status -eq 0 && "$(jq -r '.ok and .result.status == "needs_human" and ([.result.questions[].ref] == ["static", "verify", "test-results"])' <<<"$out")" == true ]]; then ok; else bad "check-needs-human" "status=$status out=$out"; fi
if [[ ! -e "$tmp/nodb" ]]; then ok; else bad "check-opens-no-db"; fi
out="$(f check --contract ../bad-contract.json)"
if [[ $? -eq 0 && "$out" == needs_human* && "$out" == *"[criterion]"* ]]; then ok; else bad "check-text" "$out"; fi

# schema: published JSON Schema paths, or content with --print
out="$(ESCAPEMENT_MANIFEST_DIR="$tmp/nodb" f --json schema)"
if [[ "$(jq -r '[.result.schemas[].name] == ["contract", "report", "verdict", "readiness"]' <<<"$out")" == true && ! -e "$tmp/nodb" ]]; then ok; else bad "schema-list" "$out"; fi
path="$(f schema contract)"
if [[ -f "$path" && "$(jq -r '."$id"' "$path")" == *"/contract.schema.json" ]]; then ok; else bad "schema-path" "$path"; fi
out="$(f --json schema verdict --print)"
if [[ "$(jq -r '.result.schema.title' <<<"$out")" == *"verdict"* ]]; then ok; else bad "schema-print" "$out"; fi
f schema nonsense >/dev/null 2>&1
if [[ $? -eq 1 ]]; then ok; else bad "schema-unknown"; fi

# Missing dependencies: a copy of the plugin layout without node_modules
fake="$tmp/fake-plugin"
mkdir -p "$fake/scripts" "$fake/manifest"
cp "$wrapper" "$fake/scripts/"
touch "$fake/manifest/factory-cli.ts"
err="$(cd "$project" && bash "$fake/scripts/factory.sh" status 2>&1 >/dev/null)"
if [[ $? -ne 0 && "$err" == *"cd '$fake/manifest' && npm ci"* ]]; then ok; else bad "missing-deps" "$err"; fi

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
