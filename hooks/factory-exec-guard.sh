#!/bin/bash
#
# factory-exec-guard.sh
#
# PreToolUse hook (matcher: Bash). While a factory run is being implemented
# in this worktree, refuse Bash calls that run the project's `static` or
# `verify` command directly, and tell Claude to run it through
# `factory exec`, which queues it on the shared build lock so test runs in
# different worktrees take turns (docs/FACTORY_DESIGN.md §4.1).
#
# It acts only when the runner's marker exists:
#   $(git rev-parse --git-path escapement-factory-run.json)
# The runner keeps that file exactly while a run is approved, implementing
# or validating under an active authorization, with the project's
# `exec-hook` setting on (the default; `exec-hook: off` opts out). Without
# it the hook exits at once: one jq and one git call, no Node.
#
# Matching is a guard against forgetting, not against an adversary: the
# command is split on && || ; | and newlines, and a part that starts with a
# guarded command (after env assignments, `time`, `command`, `nohup` or an
# opening parenthesis) is refused. Anything unexpected (no jq, no git, a
# malformed marker, a marker past the run deadline) lets the call through.
#
# Input (stdin): the PreToolUse JSON (cwd, tool_input.command)
# Exit: 0 to allow; 2 to refuse, with the reason on stderr for Claude.
#

IFS= read -r -d '' input || true
command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

cwd=$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null) || exit 0
[[ -n "$cwd" && -d "$cwd" ]] || exit 0
marker=$(git -C "$cwd" rev-parse --git-path escapement-factory-run.json 2>/dev/null) || exit 0
[[ "$marker" == /* ]] || marker="$cwd/$marker"
[[ -f "$marker" ]] || exit 0

hit=$(jq -r --slurpfile m "$marker" '
  ($m[0] // {}) as $mk
  | if ($mk.run_id | type) != "string" or ($mk.commands | type) != "array" then empty
    elif $mk.deadline_at != null
         and (($mk.deadline_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) <= now) then empty
    else
      [ (.tool_input.command // "") | splits("&&|\\|\\||;|\\||\n")
        | sub("^[\\s(]+"; "")
        | sub("^((\\w+=\\S*|time|command|nohup)\\s+)*"; "")
        | sub("[\\s)]+$"; "") ] as $parts
      | [ $mk.commands[] | select(type == "string" and . != "") as $c
          | select(any($parts[]; . == $c or startswith($c + " "))) ] | unique
      | if length == 0 then empty else [$mk.run_id, .[]] | join("\n") end
    end' <<<"$input" 2>/dev/null) || exit 0
[[ -n "$hit" ]] || exit 0

mapfile -t parts <<<"$hit"
run_id="${parts[0]}"
factory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/factory.sh"
{
  echo "Escapement factory run $run_id is active in this worktree. Run the project's checks through the factory, so they wait their turn on the shared build lock:"
  for c in "${parts[@]:1}"; do
    printf "  bash \"%s\" exec '%s' -- %s\n" "$factory" "$run_id" "$c"
  done
  echo "(A project can turn this guard off with \`exec-hook: off\` in its Escapement Settings.)"
} >&2
exit 2
