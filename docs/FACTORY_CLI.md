# Factory CLI

The factory runner is a small deterministic CLI that owns a run's state, locks, deadlines and artifacts. The design and the reasoning behind it are in [FACTORY_DESIGN.md](FACTORY_DESIGN.md), §4 and §7. This page is the reference for calling it.

The Escapement skills are one client of the runner. Other hosts, such as Escapement Studio, can call it as a subprocess and read its `--json` output. The runner never invokes a skill or an agent. It only runs git and the commands you give it.

First-release status: #59 provides `start`, `approve`, `exec`, `status`, `resume` and `revoke`. `validate`, `review-input`, `record-review`, `record-manual` and `pr` arrive in #61, #62 and #64.

## Running it

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" [options] <command> [args]
```

`scripts/factory.sh` finds the plugin from its own location and loads tsx from `manifest/node_modules`, so it works from any directory. Install the dependencies once with `cd manifest && npm ci`. `factory.sh --check` exits 0 when they are installed.

The working directory matters:
- It picks the worktree, unless `--project-root` is given.
- Relative paths, such as `--contract`, resolve against it.

## Storage

**Database.** The factory uses the shared per-user manifest database (`manifest.sh db-path`). It lives at `${XDG_DATA_HOME:-~/.local/share}/escapement/manifest.db`, or under `$ESCAPEMENT_MANIFEST_DIR`, or under `--data-dir`. Its tables come from schema migration 2:
- `factory_runs`
- `factory_authorizations`
- `factory_attempts`
- `factory_events`
- `factory_locks`

A run never needs a row in `work_items`.

**Worktree.** This is `--project-root`, or the git toplevel of the current directory. `start` records it on the run, and from then on the run is bound to it. A worktree can have one open run at a time.

**Artifacts.** These never go inside the tracked tree (§4.2). The first location that applies wins:

1. `--artifact-dir {dir}`: `{dir}/{run_id}/`
2. The project's context-path, read from the main checkout's CLAUDE.md: `{context-path}/{branch}/runs/{run_id}/`
3. Otherwise, in the main checkout: `.escapement/runs/{branch}/{run_id}/`. `start` adds `/.escapement/` to the repository's `.git/info/exclude`, so the tree stays clean.

The main checkout is used even when the run is in a linked worktree, so artifacts survive `git worktree remove`.

A run directory holds:

```
contract.json          approved contract (approve)
exec/{n}.log           output of the n-th exec
exec/{n}.json          its result record (same shape as exec's JSON result)
attempts/{n}/…         per-attempt reports, logs, results, review (#61, #62)
```

**Host obligation.** Hosts that write their own files into a worktree, such as scratchpads or session logs, must exclude them through `.git/info/exclude`. Otherwise validation sees an unclean tree.

## Commands

| Command | Does | Allowed past the run deadline |
|---|---|---|
| `start <work-item>` | Create a run in `planned` and its artifact dir | n/a |
| `approve <run_id> --contract <file>` | Store the contract and its digest, issue an active authorization, set the deadline on first approval; `planned` → `approved` | yes |
| `exec <run_id> -- <cmd> [args…]` | Run a command under the worktree and build locks with a timeout | **no** |
| `status [run_id]` | List open runs (`--all` includes closed ones), or show one run | yes |
| `resume <run_id>` | Reconcile an interrupted run (§4.7) | yes, reconciliation only |
| `revoke <run_id>` | End the active authorization | yes |

Options:

| Option | Applies to | Default |
|---|---|---|
| `--json` | all | off |
| `--data-dir <path>` | all | shared manifest |
| `--project-root <path>` | start | git toplevel of the cwd |
| `--artifact-dir <path>` | start | see Storage |
| `--issue <n>` | start | parsed from `#N` or `owner/repo#N` |
| `--manifest-id <id>` | start | none |
| `--target-ref <ref>` | start | `develop` if `origin/develop` exists, else `main` |
| `--work-type <type>` | start | none |
| `--contract <file>` | approve | required |
| `--run-budget <dur>` | approve | `2h` |
| `--timeout <dur>` | exec | `15m` |
| `--lock-timeout <dur>` | exec, resume | `30m` |
| `--all` | status | off |

Durations are written like `30s`, `15m`, `2h` or `1d`. #60 will read the defaults from `## Escapement Settings` (`command-timeout`, `lock-timeout`, `run-budget`).

**Run IDs.** A run ID is the work item made path-safe, followed by `-r{n}`. For example, `#42` gives `#42-r1`, and `fusupo/escapement#42` gives `fusupo-escapement#42-r1`. The work item can be any external identifier.

### approve

- The digest is the `sha256:` hash of the contract file's bytes. #60 adds schema validation.
- The first approval sets `deadline_at` to `approved_at` plus `--run-budget`. Later approvals never move the deadline.
- Approving a different contract marks the active authorization `superseded` and issues a new one.
- Approving the same contract again does nothing.
- A run can be approved while it is `planned`, `approved` or `implementing`.

**Authorization lifecycle:**
- `active` → `revoked` by `revoke`
- `active` → `superseded` by a new contract
- `active` → `ended` when the run is closed

### exec

1. Refuse if the run deadline has passed. The run moves to `escalated`, and exec is blocked with `run_deadline`.
2. Refuse if the run has no active authorization (`not_authorized`), or if the run is blocked, escalated or closed.
3. Take the worktree lock, then the build lock. Wait up to `--lock-timeout`, but never past the run deadline; after that the result is `lock_timeout`.
4. Run the command in the run's worktree, in its own process group, with `FACTORY_RUN_ID` set. Output goes to `exec/{n}.log`, and in text mode it is also streamed to the terminal.
5. On timeout (capped by the run deadline), or on SIGINT or SIGTERM to the runner, send SIGTERM to the whole process group, then SIGKILL after a grace period. When the command exits, anything it left running in its group is killed.
6. Release the locks, then write `exec/{n}.json`.

The first exec on an `approved` run moves it to `implementing`.

## Locks

Locks are rows in `factory_locks`, not `flock`s. They only serialize factory commands; anything outside the factory ignores them.

| Lock | Guards | Held by |
|---|---|---|
| `build` | CPU: one build or test at a time across all worktrees (per user, since the DB is per user) | `exec` while its command runs; `validate` (#61) |
| `worktree:{path}` | One factory operation at a time on a worktree | `exec`, `resume`; `validate`, `record-review`, `pr` later |

Each row records its holder: pid, process start time, command, host and run.
- A holder whose process is gone, or whose pid now belongs to another process, is treated as dead.
- The next caller takes a dead holder's lock over and logs the takeover as an event.
- `resume` also removes dead holders' locks.

Locks are always taken worktree first, then build.

## Resume rules

`resume` holds the worktree lock and, for each attempt:

| Found | Action reported | Change |
|---|---|---|
| `checks_running`, owner dead | `interrupted` | attempt → `interrupted` (still counts toward the attempt budget) |
| `checks_running` or `finalizing`, owner alive | `running` | none |
| `awaiting_review`, identity changed (HEAD moved or tree dirty) | `identity_error` | attempt → `complete`, outcome `error` |
| `awaiting_review`, no verdict file | `reissue_review` | none: the caller re-issues the review |
| `awaiting_review`, verdict file present | `record_review` | none: the caller records it |
| `finalizing`, verdict file present | `refinalize` | none: the caller re-runs finalization (#62) |
| `finalizing`, no verdict file | `needs_attention` | none |
| latest attempt `complete`, run still `validating` | `advanced_run` | run → `validated` (pass), `blocked` (blocked) or `escalated` (fail or error) |

Past the deadline, resume still reconciles, escalates the run, and starts nothing. It never resets a budget.

## JSON output

With `--json`, every command prints exactly one JSON object on stdout.

```json
{"ok": true, "command": "start", "result": { ... }}
{"ok": false, "command": "exec", "error": {"code": "run_deadline", "kind": "blocked", "message": "..."}}
```

`result` by command:
- **start:** the run row (fields below) plus `artifact_source` (`flag`, `context-path` or `in-repo`)
- **approve:** `{run, authorization, changed, superseded}`. `authorization` includes `authorizes`, the list of what the approval allows.
- **exec:** `{run_id, seq, command, cwd, exit_code, signal, outcome, reason, started_at, ended_at, duration_ms, log_path}`
  - `outcome` is `pass`, `fail` (non-zero exit) or `error` (the runner killed the command, or it couldn't start).
  - `reason` is `timeout`, `run_deadline`, `interrupted`, `spawn_failed` or null.
- **status** with a run ID: `{run, deadline_passed, authorization, authorizations, attempts, locks}`
- **status** without one: `{runs: [run, …]}`
- **resume:** `{run, deadline_passed, actions: [{attempt, found, action, detail?}], released_locks}`
- **revoke:** `{authorization}`

Run fields:
- `run_id`, `work_item`, `repo`, `worktree_path`, `branch`, `target_ref`, `artifact_dir`
- `deadline_at`
- `issue_number`, `manifest_id`, `work_type`
- `state`, `state_reason`
- `contract_digest`, `operator_action`
- `started_at`, `ended_at`

The remaining §7.1 columns appear too and stay null until later issues fill them.

Run states:
- `planned`, `approved`, `implementing`, `validating`, `validated`, `pr_open`
- `closed`: terminal
- `blocked` and `escalated`: waiting on a human

Error codes:

| kind | codes |
|---|---|
| `blocked` (exit 2) | `run_deadline`, `not_authorized`, `run_halted`, `run_closed`, `lock_timeout`, `attempt_budget` |
| `error` (exit 1) | `usage`, `no_such_run`, `run_exists`, `wrong_state`, `illegal_transition`, `no_contract`, `no_active_authorization`, `bad_duration`, `bad_work_item`, `bad_project_root`, `not_a_repo`, `detached_head`, `git_failed`, `internal` |

## Exit status

| Status | Meaning |
|---|---|
| 0 | ok |
| 1 | error (usage, unknown run, illegal transition, …) |
| 2 | blocked (a precondition stopped it; see the codes above) |
| `exec` | the command's own exit status, or 124 when the runner killed it |

`exec`'s statuses can overlap with 1 and 2 when the command itself exits with them, so hosts should read the JSON. With `--json`, the command's output goes only to the log, never to stdout.
