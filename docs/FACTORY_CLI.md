# Factory CLI

The factory runner is a small deterministic CLI that owns a run's state, locks, deadlines and artifacts. The design and the reasoning behind it are in [FACTORY_DESIGN.md](FACTORY_DESIGN.md), §4 and §7. This page is the reference for calling it.

The Escapement skills are one client of the runner. Other hosts, such as Escapement Studio, can call it as a subprocess and read its `--json` output. The runner never invokes a skill or an agent. It only runs git and the commands you give it.

First-release status: #59 provides `start`, `approve`, `exec`, `status`, `resume` and `revoke`. #60 adds contract validation, settings, `check` and `schema`. #61 adds `validate`. `review-input`, `record-review`, `record-manual` and `pr` arrive in #62 and #64.

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
attempts/{n}/report.json        the attempt's report (validate; finalized by #62)
attempts/{n}/logs/{id}.log      output of each command the attempt ran
attempts/{n}/results/{id}/      structured results of each verify invocation
attempts/{n}/review.json        reviewer verdict (#62)
```

**Schemas.** The documents hosts exchange with the runner have published JSON Schemas in `schemas/factory/` (contract, report, verdict, readiness). `factory schema` prints their paths. See [schemas/factory/README.md](../schemas/factory/README.md).

**Host obligation.** Validation requires a clean tree: no tracked changes and no untracked files that git doesn't ignore. Hosts that write their own working files into a worktree, such as scratchpads, session logs or constraint files, must list them in `.git/info/exclude` (shared by all of a repository's worktrees; the project's `.gitignore` stays untouched). Otherwise `validate` is blocked with `dirty_tree`, naming the files. A blocked validate uses no attempt, so the host can add the exclude and retry.

## Commands

| Command | Does | Allowed past the run deadline |
|---|---|---|
| `start <work-item>` | Create a run in `planned` and its artifact dir | n/a |
| `approve <run_id> --contract <file>` | Store the contract and its digest, issue an active authorization, set the deadline on first approval; `planned` → `approved` | yes |
| `exec <run_id> -- <cmd> [args…]` | Run a command under the worktree and build locks with a timeout | **no** |
| `validate <run_id>` | Run the deterministic phases for a new attempt and write its draft report | **no** |
| `status [run_id]` | List open runs (`--all` includes closed ones), or show one run | yes |
| `resume <run_id>` | Reconcile an interrupted run (§4.7) | yes, reconciliation only |
| `revoke <run_id>` | End the active authorization | yes |
| `check --contract <file>` | Readiness: is the contract valid and runnable in this project? No run or database needed | n/a |
| `schema [name]` | Path of a published JSON Schema, or its content with `--print`; no name lists them all. No database needed | n/a |

Options:

| Option | Applies to | Default |
|---|---|---|
| `--json` | all | off |
| `--data-dir <path>` | all | shared manifest |
| `--project-root <path>` | start, check | git toplevel of the cwd |
| `--artifact-dir <path>` | start | see Storage |
| `--issue <n>` | start | parsed from `#N` or `owner/repo#N` |
| `--manifest-id <id>` | start | none |
| `--target-ref <ref>` | start | `base-branch` setting, else `develop` if `origin/develop` exists, else `main` |
| `--work-type <type>` | start | none |
| `--contract <file>` | approve, check | required |
| `--run-budget <dur>` | approve | `run-budget` setting, else `2h` |
| `--timeout <dur>` | exec, validate (per command) | `command-timeout` setting, else `15m` |
| `--lock-timeout <dur>` | exec, validate, resume | `lock-timeout` setting, else `30m` |
| `--all` | status | off |
| `--print` | schema | off |

Durations are written like `30s`, `15m`, `2h` or `1d`.

## Settings

The runner reads the factory keys of `## Escapement Settings` (FACTORY_DESIGN.md §8) from the CLAUDE.md of the run's worktree, with the same section and fence rules as `context-path`. Every key is optional.

| Key | Value | Default |
|---|---|---|
| `base-branch` | branch name | none |
| `setup`, `static`, `verify` | shell command | none |
| `test-results` | `junit:{path}`, usually under `$FACTORY_RESULTS_DIR` | none |
| `required-checks` | comma list of `setup`, `static`, `verify` | `static, verify` |
| `sensitive-paths`, `validation-files` | comma list of globs | none |
| `test-files` | comma list of globs naming test files (§4.6) | `*.test.*, *.spec.*, test/, tests/, __tests__/, test_*.py, *_test.py, *_test.go` |
| `max-attempts` | positive whole number | `3` |
| `command-timeout`, `lock-timeout`, `run-budget` | duration | `15m`, `30m`, `2h` |
| `exec-hook` | `on`, `off` | `off` |
| `gate-mode` | `report-only` | `report-only` |

- Settings are read when a command needs them, not copied per run. Their digest (factory keys only) is reported by `check` and goes into each report's `policy_version`. A branch that changes them is an execution-policy change (§4.6), so weakening them is visible to review.
- A command reads settings only for a limit you didn't pass as a flag, so an invalid CLAUDE.md doesn't stop a command whose limits are all given. Otherwise invalid settings are a `bad_setting` error that names each key.
- **Globs** follow `.gitignore`: `*` and `?` stay within a path segment, `**` spans segments, a pattern without a `/` matches at any depth (`package.json`), a pattern with one is anchored at the repository root (`src/auth/**`), and a trailing `/` means a directory.
- **Risk tier.** A file matching `sensitive-paths`, or `validation-files` (an execution-policy change), makes a run `sensitive`; otherwise it is `standard`. A tier proposed in the contract is never lowered.
- `validate` reads `sensitive-paths`, `validation-files` and `test-files` at both the merge base and HEAD and uses both, so a branch can't hide a change by editing the pattern that would catch it. The other settings come from HEAD.

**Run IDs.** A run ID is the work item made path-safe, followed by `-r{n}`. For example, `#42` gives `#42-r1`, and `fusupo/escapement#42` gives `fusupo-escapement#42-r1`. The work item can be any external identifier.

### approve

- The contract must validate against `schemas/factory/contract.schema.json`, with unique criterion and evidence IDs. Its `run_id` must be this run, and its `issue`, if set, the run's issue. Otherwise `bad_contract` lists every problem.
- A contract names no commands. Checks come only from settings, so a contract can't skip or narrow a required check.
- The digest is the `sha256:` hash of the contract file's bytes.
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

### validate

`validate <run_id>` runs one attempt of the deterministic phases (§4.3–§4.6) and writes its draft report. It holds the worktree lock and the build lock throughout.

**1. Preconditions.** Checked before an attempt is allocated. Any failure is blocked (exit 2) and changes nothing: no attempt is used and the run keeps its state.

| Code | When |
|---|---|
| `run_deadline`, `run_halted`, `run_closed`, `not_authorized` | as for exec |
| `attempt_open` | an earlier attempt is still running or awaiting review |
| `bad_setting` | Escapement Settings are invalid |
| `contract_mismatch` | `{artifact_dir}/contract.json` is missing or no longer has the approved digest |
| `not_configured` | a required check has no command, or the contract has test evidence and `verify` or `test-results` is unset |
| `dirty_tree` | tracked changes or unignored untracked files (see the host obligation above) |
| `no_target`, `no_merge_base` | the target branch isn't found (`origin/{ref}`, else the local branch; nothing is fetched), or shares no history with HEAD |
| `attempt_budget` | the run has used `max-attempts` attempts |

The run must be `approved`, `implementing` or `validating` (otherwise `wrong_state`).

**2. Identity.** The attempt records `head_sha`, `target_ref`, `target_sha` and `merge_base_sha`, plus `policy_version` (`factory@{version}+settings:{digest}`) and `lockfile_digest` (over the tracked lockfiles, such as `package-lock.json`, `Cargo.lock` or `go.sum`, or null). The run moves to `validating`.

**3. setup.** Runs when `setup` is configured and the lockfile digest differs from the last successful setup in this run, which is always the case on the first attempt. If `setup` is a required check, it runs on every attempt. A failed setup makes the attempt `error`.

**4. static.**
- Runs the `static` command; a non-zero exit fails the phase.
- **Change classification** over the full diff `merge_base..head`, against git's tree at the merge base:
  - new evidence: a new test file, or a hunk that only adds a new test block (`it(`, `test(`, `describe(`, `def test_`, `func Test`, `#[test]`, `@Test` and similar);
  - modified assertion: a changed or removed line in an existing test file, a deleted test file, an added `skip`, `only` or `todo` marker, or any other addition, since ambiguous cases count as modified;
  - execution policy: a changed `validation-files` file, or changed factory settings in `CLAUDE.md`, including a dropped required check.
- Test files are those matching `test-files`, plus the files the contract's test selectors name. Renames count as a delete plus an add.
- Each modified assertion and policy change becomes an advisory finding (`assertion:{file:line}`, `policy:{path}`) that the reviewer (#62) must address.
- **Tier** from the actual diff: a sensitive path or a policy change makes it `sensitive`, whatever the contract proposed.
- **Drift:** changed files the contract didn't predict, and predicted files left unchanged, become flags.

**5. evidence.**
- **verify** runs once. Each invocation gets a new, empty `attempts/{n}/results/{id}/` directory as `FACTORY_RESULTS_DIR`. `test-results` should point into it, for example `junit:$FACTORY_RESULTS_DIR/junit.xml`, or at a directory of `.xml` files.
- A `test-results` path outside that directory is a **fixed path**. It must be gitignored. It is deleted before verify and must exist afterwards with a fresh mtime; it is then copied into the results directory.
- Missing results, results that aren't JUnit XML, or results with zero executed tests make the phase `error`, never `pass`, whatever verify's exit status.
- **test evidence** resolves `path::name` against the results: a case in that file (by its `file` attribute, a path-like classname or suite name, or pytest's dotted classname) whose name, or the end of its full name, is `name`. `*` is a wildcard, and a bare path selects every test in the file. No match is `not_found`; skipped and not_found are failures. jest-junit writes file paths only with `addFileAttribute` on (`JEST_JUNIT_ADD_FILE_ATTRIBUTE=true`).
- A test that verify doesn't run is `not_found`. The runner can't run a single test on its own, because contracts name no commands.
- **command evidence** runs on its own, in `cwd` (inside the worktree), checking `expect.exit_code`, `stdout_matches` and `stdout_not_matches`.
- **manual evidence** is `pending_manual`.
- A failed item, or a non-zero verify exit, fails the phase.

**6. Post-check.** After the last command, HEAD must still be `head_sha` and the tree clean. Otherwise the attempt is `error`: "revision changed during validation" or "checks are not side-effect free".

**7. Report and transitions.**
- The report goes to `attempts/{n}/report.json` (`schemas/factory/report.schema.json`). Its `invocations` list binds each log and results file, with its digest, to the command that produced it.
- All phases pass (or the evidence phase is `pending_manual`): the attempt is `awaiting_review` with outcome null, and the run stays `validating` until #62's reviewer records a verdict.
- A failure or error completes the attempt (`fail` or `error`) and escalates the run. There is no fix loop in the first release.
- Phases stop at the first failure; evidence after a static failure is `not_run`.

Commands run in the worktree with `FACTORY_RUN_ID` and `FACTORY_ATTEMPT` set, under the per-command timeout and the run deadline, like exec.

### check

`check` is the mechanical half of the readiness check (§3.1), for a planner to run before `start` or `approve`. It reads the contract and the settings of `--project-root` (default: the current worktree) and reports `needs_human` with a question for each gap:

- the contract is invalid (each problem), has no criteria, or has a criterion without evidence;
- a required check has no command configured;
- a setting is invalid;
- the contract has `test` evidence but the project sets no `test-results`.

Whether the criteria capture the intent, and whether scope and dependencies are clear, is the planner's judgment; it adds those questions in the same shape. `check` exits 0 for both `ready` and `needs_human`; read `status`.

## Locks

Locks are rows in `factory_locks`, not `flock`s. They only serialize factory commands; anything outside the factory ignores them.

| Lock | Guards | Held by |
|---|---|---|
| `build` | CPU: one build or test at a time across all worktrees (per user, since the DB is per user) | `exec` while its command runs; `validate` throughout |
| `worktree:{path}` | One factory operation at a time on a worktree | `exec`, `validate`, `resume`; `record-review`, `pr` later |

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
- **validate:** `{run_id, attempt, status, outcome, failed_phase, report_path, tier: {proposed, actual, reasons}, run_state}`
  - `status` is `awaiting_review` (all deterministic phases passed; `outcome` null) or `complete` (`outcome` `fail` or `error`).
  - `failed_phase` is `static`, `evidence`, or null (none, or only the post-check failed).
- **status** with a run ID: `{run, deadline_passed, authorization, authorizations, attempts, locks}`
- **status** without one: `{runs: [run, …]}`
- **resume:** `{run, deadline_passed, actions: [{attempt, found, action, detail?}], released_locks}`
- **revoke:** `{authorization}`
- **check:** a readiness document (`schemas/factory/readiness.schema.json`): `{version, status, questions: [{about, question, ref?}], tier?: {tier, reasons}, required_checks: [{name, command}], settings_digest}`
- **schema:** `{schemas: [{name, path}]}`, or `{name, path}`, plus `schema` with `--print`

Run fields:
- `run_id`, `work_item`, `repo`, `worktree_path`, `branch`, `target_ref`, `artifact_dir`
- `deadline_at`
- `issue_number`, `manifest_id`, `work_type`
- `state`, `state_reason`
- `tier_proposed`, `tier_actual`, `policy_version` (set by validate)
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
| `blocked` (exit 2) | `run_deadline`, `not_authorized`, `run_halted`, `run_closed`, `lock_timeout`, `attempt_budget`; from validate also `attempt_open`, `bad_setting`, `contract_mismatch`, `not_configured`, `dirty_tree`, `no_target`, `no_merge_base` |
| `error` (exit 1) | `usage`, `no_such_run`, `run_exists`, `wrong_state`, `illegal_transition`, `no_contract`, `bad_contract`, `bad_setting`, `no_active_authorization`, `bad_duration`, `bad_work_item`, `bad_project_root`, `not_a_repo`, `detached_head`, `git_failed`, `internal` |

## Exit status

| Status | Meaning |
|---|---|
| 0 | ok |
| 1 | error (usage, unknown run, illegal transition, …) |
| 2 | blocked (a precondition stopped it; see the codes above) |
| `exec` | the command's own exit status, or 124 when the runner killed it |
| `validate` | 0 whenever it recorded an attempt, whatever the outcome; read `outcome` from the JSON |

`exec`'s statuses can overlap with 1 and 2 when the command itself exits with them, so hosts should read the JSON. With `--json`, the command's output goes only to the log, never to stdout.
