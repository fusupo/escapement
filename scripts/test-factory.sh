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
# Never act as a real agent identity, from the environment or ~/.config/escapement/agent.env.
unset ESCAPEMENT_AGENT_GH_TOKEN ESCAPEMENT_AGENT_NAME ESCAPEMENT_AGENT_EMAIL GH_TOKEN GITHUB_TOKEN
export XDG_CONFIG_HOME="$tmp/config"

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

# agent: the commit identity from the environment; without one, blocked
out="$(ESCAPEMENT_AGENT_NAME=Bot ESCAPEMENT_AGENT_EMAIL=bot@example.invalid f --json agent)"
if [[ "$(jq -r '.ok and .result.name == "Bot" and .result.email == "bot@example.invalid" and .result.source == "env"' <<<"$out")" == true ]]; then ok; else bad "agent-env" "$out"; fi
out="$(f --json agent)"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code == "no_agent_token"' <<<"$out")" == true ]]; then ok; else bad "agent-no-token" "status=$status out=$out"; fi
# agent.env: the identity from the user's config file, refused unless only the user can read it
mkdir -p "$tmp/config/escapement"
printf 'ESCAPEMENT_AGENT_NAME="File Agent"\nESCAPEMENT_AGENT_EMAIL=file@example.invalid\n' > "$tmp/config/escapement/agent.env"
chmod 644 "$tmp/config/escapement/agent.env"
out="$(f --json agent)"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code' <<<"$out")" == agent_env_permissions ]]; then ok; else bad "agent-env-permissions" "status=$status out=$out"; fi
chmod 600 "$tmp/config/escapement/agent.env"
out="$(f --json agent)"
if [[ "$(jq -r '.result.name == "File Agent" and .result.email == "file@example.invalid"' <<<"$out")" == true ]]; then ok; else bad "agent-env-file" "$out"; fi
rm "$tmp/config/escapement/agent.env"

# authorization before any run: no database yet, and asking doesn't create one
out="$(f --json authorization)"
status=$?
if [[ $status -eq 0 && "$(jq -r '.ok and (.result.matched | not) and .result.reasons == ["no_database"]' <<<"$out")" == true && ! -e "$tmp/data" ]]; then ok; else bad "authorization-no-database" "status=$status out=$out"; fi
out="$(CWD="$other" f --json authorization)"
if [[ "$(jq -r '.result.reasons == ["not_a_repo"]' <<<"$out")" == true ]]; then ok; else bad "authorization-not-a-repo" "$out"; fi

# without a database, only start creates one: other commands answer "no such run"
out="$(f --json exec 'x#1-r1' -- true)"
status=$?
if [[ $status -eq 1 && "$(jq -r '.error.code' <<<"$out")" == no_such_run && ! -e "$tmp/data" ]]; then ok; else bad "no-database-exec" "status=$status out=$out"; fi
out="$(f --json status)"
if [[ "$(jq -r '.ok and .result.runs == []' <<<"$out")" == true && ! -e "$tmp/data" ]]; then ok; else bad "no-database-status" "$out"; fi
f --json archive 'x#1-r1' --path /tmp/nowhere >/dev/null
if [[ ! -e "$tmp/data" ]]; then ok; else bad "no-database-archive-creates-nothing"; fi

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

# the approved run matches this worktree; skills may act without asking
out="$(f --json authorization)"
if [[ "$(jq -r '.result.matched and .result.run_id == "#5-r1" and .result.next == "implement" and (.result.authorizes | index("open_pr") != null)' <<<"$out")" == true ]]; then ok; else bad "authorization-matched" "$out"; fi

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

# start on the target branch is blocked (exit 2) and creates no run
out="$(CWD="$other" f --json start --project-root "$project" --target-ref 5-thing '#7')"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.kind == "blocked" and .error.code == "on_target_branch"' <<<"$out")" == true ]]; then ok; else bad "start-on-target-branch" "status=$status out=$out"; fi

# resume
out="$(f --json resume '#5-r1')"
if [[ "$(jq -r '.ok and (.result.actions | length) == 0' <<<"$out")" == true ]]; then ok; else bad "resume-json" "$out"; fi

# revoke, then exec is blocked: exit 2 and kind "blocked"
out="$(f --json revoke '#5-r1')"
if [[ "$(jq -r '.ok and .result.authorization.status == "revoked"' <<<"$out")" == true ]]; then ok; else bad "revoke-json" "$out"; fi
out="$(f --json exec '#5-r1' -- true)"
status=$?
if [[ $status -eq 2 && "$(jq -r '.ok == false and .error.kind == "blocked" and .error.code == "not_authorized"' <<<"$out")" == true ]]; then ok; else bad "blocked-exit-2" "status=$status out=$out"; fi

# without an active authorization, authorization says so (still exit 0)
out="$(f --json authorization)"
status=$?
if [[ $status -eq 0 && "$(jq -r '(.result.matched | not) and (.result.reasons | index("no_active_authorization") != null)' <<<"$out")" == true ]]; then ok; else bad "authorization-revoked" "status=$status out=$out"; fi

# escalate: the host stops the run to wait on a human; again is a no-op
out="$(f --json escalate '#5-r1' --reason 'blocked: dirty_tree')"
if [[ "$(jq -r '.ok and .result.changed and .result.run.state == "escalated" and .result.run.state_reason == "blocked: dirty_tree"' <<<"$out")" == true ]]; then ok; else bad "escalate-json" "$out"; fi
out="$(f --json escalate '#5-r1' --reason 'again')"
if [[ "$(jq -r '.ok and (.result.changed | not)' <<<"$out")" == true ]]; then ok; else bad "escalate-noop" "$out"; fi

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
out="$(ESCAPEMENT_MANIFEST_DIR="$tmp/nodb" f --json check)"
if [[ $? -eq 0 && "$(jq -r '.result.status == "needs_human" and ([.result.questions[].ref] == ["static", "verify"]) and (.result | has("tier") | not)' <<<"$out")" == true ]]; then ok; else bad "check-settings-only" "$out"; fi

# schema: published JSON Schema paths, or content with --print
out="$(ESCAPEMENT_MANIFEST_DIR="$tmp/nodb" f --json schema)"
if [[ "$(jq -r '[.result.schemas[].name] == ["contract", "report", "verdict", "readiness"]' <<<"$out")" == true && ! -e "$tmp/nodb" ]]; then ok; else bad "schema-list" "$out"; fi
path="$(f schema contract)"
if [[ -f "$path" && "$(jq -r '."$id"' "$path")" == *"/contract.schema.json" ]]; then ok; else bad "schema-path" "$path"; fi
out="$(f --json schema verdict --print)"
if [[ "$(jq -r '.result.schema.title' <<<"$out")" == *"verdict"* ]]; then ok; else bad "schema-print" "$out"; fi
f schema nonsense >/dev/null 2>&1
if [[ $? -eq 1 ]]; then ok; else bad "schema-unknown"; fi

# validate: a project with static and verify checks. verify copies a JUnit
# file into $FACTORY_RESULTS_DIR; ci/verify-exit sets its exit status.
make_vproject() {
  local dir="$1" verify_exit="$2"
  mkdir -p "$dir/ci" &&
    (
      cd "$dir" &&
        git init -q -b main &&
        git init -q --bare "$dir.origin.git" &&
        git remote add origin "$dir.origin.git" &&
        printf '## Escapement Settings\n\n- **static**: true\n- **verify**: sh ci/verify.sh\n- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml\n' > CLAUDE.md &&
        printf 'cp ci/junit.xml "$FACTORY_RESULTS_DIR/junit.xml"\nexit "$(cat ci/verify-exit)"\n' > ci/verify.sh &&
        echo "$verify_exit" > ci/verify-exit &&
        echo '<testsuites><testsuite name="s"><testcase name="works" file="t.ts"/></testsuite></testsuites>' > ci/junit.xml &&
        git add -A &&
        git -c user.name=t -c user.email=t@example.invalid commit -q -m init &&
        git checkout -q -b 9-validate &&
        echo change > change.txt &&
        git add -A &&
        git -c user.name=t -c user.email=t@example.invalid commit -q -m work
    )
}
vproject="$tmp/vproject"
make_vproject "$vproject" 0
sed 's/#5-r1/#9-r1/' "$project/../contract.json" > "$tmp/vcontract.json"
CWD="$vproject" f --json start '#9' --target-ref main >/dev/null
CWD="$vproject" f --json approve '#9-r1' --contract "$tmp/vcontract.json" >/dev/null

# the exec guard's marker: on while the approved run is implemented (inside .git, not the tree)
guard="$vproject/.git/escapement-factory-run.json"
if [[ "$(jq -r '.run_id == "#9-r1" and .commands == ["true", "sh ci/verify.sh"]' "$guard" 2>/dev/null)" == true ]]; then ok; else bad "guard-marker-on-approve" "$(cat "$guard" 2>&1)"; fi

# an untracked scratchpad blocks validate (exit 2) and uses no attempt
echo notes > "$vproject/SCRATCHPAD_9.md"
out="$(CWD="$vproject" f --json validate '#9-r1')"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.kind == "blocked" and .error.code == "dirty_tree" and (.error.message | contains("SCRATCHPAD_9.md") and contains(".git/info/exclude"))' <<<"$out")" == true ]]; then ok; else bad "validate-blocked-scratchpad" "status=$status out=$out"; fi
out="$(CWD="$vproject" f --json status '#9-r1')"
if [[ "$(jq -r '(.result.attempts | length) == 0 and .result.run.state == "approved"' <<<"$out")" == true ]]; then ok; else bad "validate-blocked-no-attempt" "$out"; fi

# factory exclude lists it in .git/info/exclude (no database needed), once
out="$(CWD="$vproject" ESCAPEMENT_MANIFEST_DIR="$tmp/no-db" f --json exclude 'SCRATCHPAD_*' 'SESSION_LOG_*')"
if [[ $? -eq 0 && "$(jq -r '.ok and .result.added == ["SCRATCHPAD_*", "SESSION_LOG_*"] and (.result.path | endswith(".git/info/exclude"))' <<<"$out")" == true && ! -e "$tmp/no-db" ]]; then ok; else bad "exclude-json" "$out"; fi
out="$(CWD="$vproject" f --json exclude 'SCRATCHPAD_*')"
if [[ "$(jq -r '.result.added == [] and .result.present == ["SCRATCHPAD_*"]' <<<"$out")" == true && "$(grep -c '^SCRATCHPAD_\*$' "$vproject/.git/info/exclude")" == 1 ]]; then ok; else bad "exclude-idempotent" "$out"; fi
out="$(CWD="$vproject" f --json exclude '!README.md')"
if [[ $? -eq 1 && "$(jq -r '.error.code' <<<"$out")" == bad_pattern ]]; then ok; else bad "exclude-bad-pattern" "$out"; fi

# excluded, it validates; --json gives the outcome and report path
out="$(CWD="$vproject" f --json validate '#9-r1')"
status=$?
if [[ $status -eq 0 && "$(jq -r '.ok and .result.status == "awaiting_review" and .result.outcome == null and .result.attempt == 1' <<<"$out")" == true ]]; then ok; else bad "validate-json" "status=$status out=$out"; fi
report="$(jq -r .result.report_path <<<"$out")"
if [[ -f "$report" && "$(jq -r '.evidence[0].executed' "$report")" == passed ]]; then ok; else bad "validate-report" "$report"; fi

# review-input writes the bundle; the issue text comes from the host
echo '# Make it work' > "$tmp/issue.md"
out="$(CWD="$vproject" f --json review-input '#9-r1' 1 --issue-file "$tmp/issue.md")"
status=$?
bundle="$(jq -r .result.bundle_path <<<"$out")"
if [[ $status -eq 0 && -f "$bundle" && "$(jq -r '.ok and .result.required.evidence == 1' <<<"$out")" == true ]]; then ok; else bad "review-input-json" "status=$status out=$out"; fi
if [[ "$(jq -r '.issue.path' "$bundle")" != null && -f "$(jq -r .diff "$bundle")" && -f "$(jq -r .reviewer_prompt "$bundle")" ]]; then ok; else bad "review-input-bundle" "$(cat "$bundle")"; fi
if [[ -z "$(git -C "$vproject" status --porcelain)" ]]; then ok; else bad "review-input-tree-clean" "$(git -C "$vproject" status --porcelain)"; fi
# the bundle's commands name the database, so they work from a shell without ESCAPEMENT_MANIFEST_DIR
if [[ "$(jq -r '.runner.exec' "$bundle")" == *"--data-dir"*"$tmp/data"*" exec "* && "$(jq -r '.verdict.record' "$bundle")" == *"--data-dir"*"$tmp/data"*" record-review "* ]]; then ok; else bad "review-input-commands-name-db" "$(jq -c '{exec: .runner.exec, record: .verdict.record}' "$bundle")"; fi

# a verdict missing its evidence judgment is blocked; the attempt still awaits review
jq '{version: 1, source_digest: .source.digest, evidence: [], sensitive_paths: [], modified_assertions: [], findings: []}' "$bundle" > "$tmp/incomplete.json"
out="$(CWD="$vproject" f --json record-review '#9-r1' 1 "$tmp/incomplete.json")"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code == "incomplete_verdict" and (.error.message | contains("AC-1.e1: no judgment"))' <<<"$out")" == true ]]; then ok; else bad "record-review-incomplete" "status=$status out=$out"; fi
out="$(CWD="$vproject" f --json status '#9-r1')"
if [[ "$(jq -r '.result.attempts[0].status' <<<"$out")" == awaiting_review ]]; then ok; else bad "record-review-incomplete-state" "$out"; fi

# a complete verdict built from the bundle, read from stdin, passes and validates the run
jq '{version: 1, source_digest: .source.digest,
     evidence: [.required.evidence[] | {id, (.judgment): "yes", rationale: "covers it"}],
     sensitive_paths: [.required.sensitive_paths[] | {path, signoff: "approve", rationale: "ok"}],
     modified_assertions: [.required.modified_assertions[] | {location, justified: true, rationale: "ok"}],
     findings: []}' "$bundle" > "$tmp/verdict.json"
out="$(CWD="$vproject" f --json record-review '#9-r1' 1 - < "$tmp/verdict.json")"
status=$?
if [[ $status -eq 0 && "$(jq -r '.ok and .result.outcome == "pass" and .result.run_state == "validated" and .result.noop == false' <<<"$out")" == true ]]; then ok; else bad "record-review-json" "status=$status out=$out"; fi
if [[ "$(jq -r '.status == "complete" and .outcome == "pass" and .evidence[0].supports_criterion == "yes"' "$report")" == true ]]; then ok; else bad "record-review-final-report" "$(cat "$report")"; fi
if [[ ! -e "$guard" ]]; then ok; else bad "guard-marker-off-when-validated"; fi

# the same verdict again is a no-op; a different one is a conflict
out="$(CWD="$vproject" f --json record-review '#9-r1' 1 "$tmp/verdict.json")"
if [[ $? -eq 0 && "$(jq -r '.result.noop' <<<"$out")" == true ]]; then ok; else bad "record-review-noop" "$out"; fi
jq '.findings = [{severity: "advisory", detail: "late thought"}]' "$tmp/verdict.json" > "$tmp/other-verdict.json"
out="$(CWD="$vproject" f --json record-review '#9-r1' 1 "$tmp/other-verdict.json")"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code' <<<"$out")" == verdict_conflict ]]; then ok; else bad "record-review-conflict" "status=$status out=$out"; fi

# pr: push and open the PR as the agent. A stub gh (state in a JSON file)
# stands in for GitHub; the origin is a local bare repository (make_vproject).
mkdir -p "$tmp/ghbin"
cat > "$tmp/ghbin/gh" <<'GH'
#!/usr/bin/env bash
state="$GH_STUB_STATE"
printf '%s\t%s\n' "${GH_TOKEN:-}" "$*" >> "$GH_STUB_STATE.log"
flag() { local n="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$n" ]] && { echo "$2"; return; }; shift; done; }
case "$1 $2" in
  "pr list") jq -c --arg h "$(flag --head "$@")" '[.[] | select(.headRefName == $h and .state == "OPEN")]' "$state" ;;
  "pr create")
    n=$(( $(jq length "$state") + 1 ))
    jq --argjson n "$n" --arg h "$(flag --head "$@")" --arg base "$(flag --base "$@")" --arg t "$(flag --title "$@")" --rawfile b "$(flag --body-file "$@")" \
      '. + [{number: $n, url: ("https://github.com/o/r/pull/" + ($n | tostring)), headRefName: $h, baseRefName: $base, title: $t, body: $b, state: "OPEN", headRepositoryOwner: null}]' \
      "$state" > "$state.tmp" && mv "$state.tmp" "$state"
    echo "https://github.com/o/r/pull/$n" ;;
  "pr view") jq -c --argjson n "$3" '.[] | select(.number == $n) | {state, mergedAt: (.mergedAt // null)}' "$state" ;;
  "pr edit")
    jq --argjson n "$3" --rawfile b "$(flag --body-file "$@")" 'map(if .number == $n then .body = $b else . end)' "$state" > "$state.tmp" && mv "$state.tmp" "$state" ;;
  *) echo "stub gh: unsupported: $*" >&2; exit 2 ;;
esac
GH
chmod +x "$tmp/ghbin/gh"
echo '[]' > "$tmp/prs.json"
printf '## Summary\nMakes it work.\n' > "$tmp/narrative.md"
ghf() { PATH="$tmp/ghbin:$PATH" GH_STUB_STATE="$tmp/prs.json" ESCAPEMENT_AGENT_GH_TOKEN=agent-token CWD="$vproject" f "$@"; }

out="$(CWD="$vproject" f --json pr '#9-r1' --title 'feat: it works (#9)')"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code' <<<"$out")" == no_agent_token ]]; then ok; else bad "pr-no-token" "status=$status out=$out"; fi
out="$(ghf --json pr '#9-r1' --title 'feat: it works (#9)' --body-file "$tmp/narrative.md")"
status=$?
if [[ $status -eq 0 && "$(jq -r '.ok and .result.action == "created" and .result.pr_number == 1 and .result.state == "pr_open" and .result.outcome == "pass"' <<<"$out")" == true ]]; then ok; else bad "pr-created" "status=$status out=$out"; fi
if [[ "$(git -C "$vproject.origin.git" rev-parse refs/heads/9-validate 2>/dev/null)" == "$(git -C "$vproject" rev-parse HEAD)" ]]; then ok; else bad "pr-pushed"; fi
if [[ "$(jq -r '.[0] | .baseRefName == "main" and (.body | startswith("## Summary\nMakes it work.") and contains("<!-- escapement:factory-report:begin -->"))' "$tmp/prs.json")" == true ]]; then ok; else bad "pr-body" "$(cat "$tmp/prs.json")"; fi
if [[ "$(cut -f1 "$tmp/prs.json.log" | sort -u)" == agent-token ]]; then ok; else bad "pr-as-agent" "$(cat "$tmp/prs.json.log")"; fi

# again: the same PR is found and updated, not duplicated
out="$(ghf --json pr '#9-r1')"
if [[ "$(jq -r '.result.action == "updated" and .result.pr_number == 1' <<<"$out")" == true && "$(jq length "$tmp/prs.json")" == 1 ]]; then ok; else bad "pr-idempotent" "$out"; fi
out="$(CWD="$vproject" f --json authorization)"
if [[ "$(jq -r '.result.matched and .result.state == "pr_open" and .result.next == "await_merge" and .result.pr_number == 1' <<<"$out")" == true ]]; then ok; else bad "pr-authorization-next" "$out"; fi

# record-manual: this report has no manual evidence, so nothing awaits a human (exit 2)
out="$(CWD="$vproject" f --json record-manual '#9-r1' AC-1.e1 pass --note 'looked')"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code' <<<"$out")" == not_pending_manual ]]; then ok; else bad "record-manual-not-pending" "status=$status out=$out"; fi

# archive: --close refuses while the PR is open; once merged it closes the run
out="$(ghf --json archive '#9-r1' --path "$tmp/archive/9" --close)"
status=$?
if [[ $status -eq 2 && "$(jq -r '.error.code' <<<"$out")" == pr_open ]]; then ok; else bad "archive-pr-open" "status=$status out=$out"; fi
jq 'map(.state = "MERGED")' "$tmp/prs.json" > "$tmp/prs.tmp" && mv "$tmp/prs.tmp" "$tmp/prs.json"
out="$(ghf --json archive '#9-r1' --path "$tmp/archive/9" --close)"
if [[ "$(jq -r --arg p "$tmp/archive/9" '.ok and .result.closed == "merged" and .result.state == "closed" and .result.archive_path == $p' <<<"$out")" == true ]]; then ok; else bad "archive-close-merged" "$out"; fi
out="$(CWD="$vproject" f --json authorization)"
if [[ "$(jq -r '.result.reasons == ["no_run"]' <<<"$out")" == true ]]; then ok; else bad "archive-closed-no-run" "$out"; fi

# a failing attempt still exits 0; the outcome is in the JSON
fproject="$tmp/fproject"
make_vproject "$fproject" 1
# Run IDs are unique across the database, so this run of #9 is r2.
sed 's/#5-r1/#9-r2/' "$project/../contract.json" > "$tmp/fcontract.json"
CWD="$fproject" f --json start '#9' --target-ref main >/dev/null
CWD="$fproject" f --json approve '#9-r2' --contract "$tmp/fcontract.json" >/dev/null
out="$(CWD="$fproject" f --json validate '#9-r2')"
status=$?
if [[ $status -eq 0 && "$(jq -r '.result.outcome == "fail" and .result.failed_phase == "evidence" and .result.run_state == "escalated"' <<<"$out")" == true ]]; then ok; else bad "validate-fail-json" "status=$status out=$out"; fi

# prompt: the reviewer prompt ships as data, found through the runner
out="$(f prompt reviewer)"
if [[ "$out" == */prompts/factory/validation-reviewer.md && -f "$out" ]]; then ok; else bad "prompt-path" "$out"; fi
out="$(f --json prompt reviewer --print)"
if [[ "$(jq -r '.ok and (.result.content | contains("# Validation reviewer"))' <<<"$out")" == true ]]; then ok; else bad "prompt-print" "$out"; fi
out="$(f --json prompt nope)"
if [[ $? -eq 1 && "$(jq -r .error.code <<<"$out")" == usage ]]; then ok; else bad "prompt-unknown" "$out"; fi

# Missing dependencies: a copy of the plugin layout without node_modules
fake="$tmp/fake-plugin"
mkdir -p "$fake/scripts" "$fake/manifest"
cp "$wrapper" "$fake/scripts/"
touch "$fake/manifest/factory-cli.ts"
err="$(cd "$project" && bash "$fake/scripts/factory.sh" status 2>&1 >/dev/null)"
if [[ $? -ne 0 && "$err" == *"cd '$fake/manifest' && npm ci"* ]]; then ok; else bad "missing-deps" "$err"; fi

# setup-work's factory path (skills/setup-work, Phases 0.5, 3.2 and 4.5), as
# the skill runs it: an approved plan yields a contract whose digest is the
# authorization's.
sproject="$tmp/sproject"
mkdir -p "$sproject"
(
  cd "$sproject" &&
    git init -q -b main &&
    printf '## Escapement Settings\n\n- **static**: true\n- **verify**: true\n- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml\n' > CLAUDE.md &&
    git add -A &&
    git -c user.name=t -c user.email=t@example.invalid commit -q -m init
)
sf() { (cd "$sproject" && bash "$wrapper" "$@"); }
out="$(sf --json check)"
if [[ "$(jq -r '.result.status == "ready" and .result.target_ref == "main"' <<<"$out")" == true ]]; then ok; else bad "setup-factory-available" "$out"; fi

# a criterion without evidence: readiness is needs_human, naming it
cat > "$tmp/draft-bad.json" <<'JSON'
{"version": 1, "run_id": "pending", "issue": 11, "risk_tier_proposed": "standard",
 "criteria": [{"id": "AC-1", "text": "It works", "evidence": [{"id": "AC-1.e1", "type": "test", "kind": "new_behavior", "selector": "t.ts::works"}]},
              {"id": "AC-2", "text": "It is fast", "evidence": []}]}
JSON
out="$(sf --json check --contract "$tmp/draft-bad.json")"
if [[ "$(jq -r '.result.status == "needs_human" and ([.result.questions[] | select(.about == "criterion") | .ref] == ["AC-2"])' <<<"$out")" == true ]]; then ok; else bad "setup-criterion-without-evidence" "$out"; fi

# the planned contract is ready before any run exists
jq 'del(.criteria[1])' "$tmp/draft-bad.json" > "$tmp/draft.json"
out="$(sf --json check --contract "$tmp/draft.json")"
sroot="$(cd "$sproject" && pwd -P)"
if [[ "$(jq -r '.result.status' <<<"$out")" == ready && "$(sf --json status --all | jq --arg w "$sroot" '[.result.runs[] | select(.worktree_path == $w)] | length')" == 0 ]]; then ok; else bad "setup-draft-ready-no-run" "$out"; fi

# Approve + authorize run: check out, exclude, start, write, check, approve
(cd "$sproject" && git branch -q --no-track 11-thing main && git checkout -q 11-thing && echo plan > SCRATCHPAD_11.md && echo '{}' > SESSION_LOG_1.jsonl)
sf --json exclude 'SCRATCHPAD_*' 'SESSION_LOG_*' AGENT_CONSTRAINTS.md >/dev/null
out="$(sf --json start 'acme/s#11' --target-ref main)"
run_id="$(jq -r .result.run_id <<<"$out")"
art="$(jq -r .result.artifact_dir <<<"$out")"
if [[ "$run_id" == "acme-s#11-r1" && "$(jq -r .result.issue_number <<<"$out")" == 11 && -d "$art" ]]; then ok; else bad "setup-start" "$out"; fi
jq --arg r "$run_id" '.run_id = $r' "$tmp/draft.json" > "$art/contract.draft.json"
out="$(sf --json check --contract "$art/contract.draft.json")"
if [[ "$(jq -r '.result.status' <<<"$out")" == ready ]]; then ok; else bad "setup-check-in-run" "$out"; fi
out="$(sf --json approve "$run_id" --contract "$art/contract.draft.json")"
approved="$(jq -r .result.authorization.contract_digest <<<"$out")"
stored="sha256:$(sha256sum "$art/contract.json" | cut -d' ' -f1)"
drafted="sha256:$(sha256sum "$art/contract.draft.json" | cut -d' ' -f1)"
st="$(sf --json status "$run_id")"
if [[ "$approved" == "$stored" && "$stored" == "$drafted" &&
      "$(jq -r --arg d "$stored" '.result.run.state == "approved" and .result.authorization.status == "active" and .result.authorization.contract_digest == $d' <<<"$st")" == true ]]; then ok; else bad "setup-digest-matches-authorization" "approved=$approved stored=$stored drafted=$drafted
$st"; fi
if [[ -z "$(cd "$sproject" && git status --porcelain)" ]]; then ok; else bad "setup-tree-clean" "$(cd "$sproject" && git status --porcelain)"; fi

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
