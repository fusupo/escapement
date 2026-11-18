# Factory CLI

The factory runner is a small deterministic CLI that owns a run's state, locks, deadlines and artifacts. The design and the reasoning behind it are in [FACTORY_DESIGN.md](FACTORY_DESIGN.md), §4 and §7. This page is the reference for calling it.

The Escapement skills are one client of the runner. Other hosts, such as Escapement Studio, can call it as a subprocess and read its `--json` output. The runner never invokes a skill or an agent. It runs git and the commands you give it, and, for a run's push and PR, `gh` as the AI agent's GitHub identity (see [GitHub and the agent identity](#github-and-the-agent-identity)).

First-release status: #59 provides `start`, `approve`, `exec`, `status`, `resume` and `revoke`. #60 adds contract validation, settings, `check` and `schema`. #61 adds `validate`. #62 adds `review-input`, `record-review` and `prompt`. #63 adds `exclude`, a settings-only `check`, and a `start` that refuses the target branch; `setup-work` drives `check`, `exclude`, `start` and `approve` (its factory path). #64 adds `authorization`, `agent`, `escalate`, `pr`, `record-manual` and `archive`, GitHub access as the agent, and the exec guard; `do-work`, `commit-changes`, `create-pr`, `validate-work` and `archive-work` drive them (the authorized path, FACTORY_DESIGN.md §6.1). #65 adds fault injection for crash tests, the `validate` next step, and killing a crashed check's process group; Escapement itself is configured as a factory project. #80 adds `push`, so skills push as the agent outside a run too. #99 adds `check-critique`, `record-critique` and the `critic` prompt; `setup-work` runs one round of plan critique before approval, and a reviewer's `judgment:` finding carries `evidence_type`. #103 adds `record-manual --assisted --attachment`, shows recorded manual outcomes before the report resolves (`record-manual`, `status`, the PR section), and bundles the Playwright MCP server that `validate-work` uses to carry out a manual check.

## Running it

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" [options] <command> [args]
```

`scripts/factory.sh` finds the plugin from its own location and loads tsx from `manifest/node_modules`, so it works from any directory. Install the dependencies once with `cd manifest && npm ci`. `factory.sh --check` exits 0 when they are installed.

The working directory matters:
- It picks the worktree, unless `--project-root` is given.
- Relative paths, such as `--contract`, resolve against it.

## Storage

**Database.** The factory uses the shared per-user manifest database (`manifest.sh db-path`). Only `start` creates it. Every other command answers without creating it when it doesn't exist: `authorization` says `no_database`, `status` lists no runs, and a command naming a run fails with `no_such_run`. It lives at `${XDG_DATA_HOME:-~/.local/share}/escapement/manifest.db`, or under `$ESCAPEMENT_MANIFEST_DIR`, or under `--data-dir`. Its tables come from schema migration 2:
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
attempts/{n}/report.json        the attempt's report (validate; finalized by record-review)
attempts/{n}/report.r{k}.json   later revisions (record-manual), k = 2, 3, …
attempts/{n}/logs/{id}.log      output of each command the attempt ran
attempts/{n}/results/{id}/      structured results of each verify invocation
attempts/{n}/review.json        reviewer verdict (record-review)
pr/body.md                      the PR description as last sent (pr)
```

**Schemas.** The documents hosts exchange with the runner have published JSON Schemas in `schemas/factory/` (contract, report, verdict, readiness). `factory schema` prints their paths. See [schemas/factory/README.md](../schemas/factory/README.md).

**Host obligation.** Validation requires a clean tree: no tracked changes and no untracked files that git doesn't ignore. Hosts that write their own working files into a worktree, such as scratchpads, session logs or constraint files, must list them in `.git/info/exclude` (shared by all of a repository's worktrees; the project's `.gitignore` stays untouched). `factory exclude <pattern>…` does that. Otherwise `validate` is blocked with `dirty_tree`, naming the files. A blocked validate uses no attempt, so the host can add the exclude and retry.

## Commands

| Command | Does | Allowed past the run deadline |
|---|---|---|
| `start <work-item>` | Create a run in `planned` and its artifact dir. Refused on the target branch | n/a |
| `approve <run_id> --contract <file>` | Store the contract and its digest, issue an active authorization, set the deadline on first approval; `planned` → `approved` | yes |
| `exec <run_id> -- <cmd> [args…]` | Run a command under the worktree and build locks with a timeout | **no** |
| `validate <run_id>` | Run the deterministic phases for a new attempt and write its draft report | **no** |
| `review-input <run_id> <attempt>` | Write the reviewer's bundle for an attempt awaiting review | **no** |
| `record-review <run_id> <attempt> <file>` | Check a reviewer verdict (`-` reads stdin), finalize the report and complete the attempt | yes, for a review in progress |
| `record-critique <run_id> <file>` | Attach the final plan critique to the run: `critique.json` and one `critique_finding` event per finding | yes |
| `status [run_id]` | List open runs (`--all` includes closed ones), or show one run | yes |
| `resume <run_id>` | Reconcile an interrupted run (§4.7) | yes, reconciliation only |
| `revoke <run_id>` | End the active authorization | yes |
| `escalate <run_id> --reason <text>` | Stop the run to wait on a human | yes |
| `continue <run_id> --reason <text>` | Take an escalated run whose latest attempt failed or errored back to `implementing` (the fix loop's operator path) | **no** |
| `authorization` | Does this worktree's run let skills act without asking? Read-only; never creates the database | yes |
| `agent` | The AI agent's commit identity. No database needed | n/a |
| `push` | Push the current branch as the agent, with no run (plain skills). Never forced, never the base branch, `main` or `master`. No database needed | n/a |
| `pr <run_id>` | Push the branch and open or update the run's PR, as the agent | **no** to create; yes to update |
| `record-manual <run_id> <evidence_id> pass\|fail --note <text> [--assisted [--attachment <file>]...]` | Record a human's outcome for manual evidence | yes |
| `archive <run_id> --path <dir>` | Record where the run was archived; `--close` closes it | yes |
| `check [--contract <file>]` | Readiness: is the contract valid and runnable in this project? Without `--contract`, only the settings are checked. No run or database needed | n/a |
| `check-critique <file> [--final]` | Check a plan critique against `critique.schema.json` and its rules (`-` reads stdin). No run or database needed | n/a |
| `exclude <pattern>…` | Add the host's working-file patterns to the repository's `.git/info/exclude`. No run or database needed | n/a |
| `schema [name]` | Path of a published JSON Schema, or its content with `--print`; no name lists them all. No database needed | n/a |
| `prompt [name]` | Path of an agent prompt the factory ships (`reviewer`, `critic`), or its content with `--print`. No database needed | n/a |

Options:

| Option | Applies to | Default |
|---|---|---|
| `--json` | all | off |
| `--data-dir <path>` | all | shared manifest |
| `--project-root <path>` | start, check, exclude, authorization | git toplevel of the cwd |
| `--artifact-dir <path>` | start | see Storage |
| `--issue <n>` | start | parsed from `#N` or `owner/repo#N` |
| `--manifest-id <id>` | start | none |
| `--target-ref <ref>` | start | `base-branch` setting, else `develop` if `origin/develop` exists, else `main` |
| `--work-type <type>` | start | none |
| `--contract <file>` | approve (required), check (optional) | none |
| `--run-budget <dur>` | approve | `run-budget` setting, else `2h` |
| `--timeout <dur>` | exec, validate (per command) | `command-timeout` setting, else `15m` |
| `--issue-file <file>` | review-input | none |
| `--lock-timeout <dur>` | exec, validate, review-input, record-review, resume, pr, record-manual, archive | `lock-timeout` setting, else `30m` |
| `--reason <text>` | escalate, continue (required) | none |
| `--title <text>` | pr (needed to create the PR) | none |
| `--body-file <file>` | pr: the host's PR description | the PR's own description on update; none on create |
| `--note <text>` | record-manual (required) | none |
| `--recorder <name>` | record-manual | the OS user |
| `--assisted` | record-manual: the agent carried out the check's steps and the human decided | off |
| `--attachment <file>` | record-manual, with `--assisted`; repeatable, at most 20 | none |
| `--path <dir>` | archive (required) | none |
| `--close`, `--abandon` | archive | off |
| `--all` | status | off |
| `--print` | schema, prompt | off |
| `--final` | check-critique: the record after the critique round, every finding with a disposition | off |

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
| `exec-hook` | `on`, `off`: the exec guard during runs | `on` |
| `gate-mode` | `report-only` | `report-only` |

- Settings are read when a command needs them, not copied per run. Their digest (factory keys only) is reported by `check` and goes into each report's `policy_version`. A branch that changes them is an execution-policy change (§4.6), so weakening them is visible to review.
- A command reads settings only for a limit you didn't pass as a flag, so an invalid CLAUDE.md doesn't stop a command whose limits are all given. Otherwise invalid settings are a `bad_setting` error that names each key.
- **Globs** follow `.gitignore`: `*` and `?` stay within a path segment, `**` spans segments, a pattern without a `/` matches at any depth (`package.json`), a pattern with one is anchored at the repository root (`src/auth/**`), and a trailing `/` means a directory.
- **Risk tier.** A file matching `sensitive-paths`, or `validation-files` (an execution-policy change), makes a run `sensitive`; otherwise it is `standard`. A tier proposed in the contract is never lowered.
- `validate` reads `sensitive-paths`, `validation-files` and `test-files` at both the merge base and HEAD and uses both, so a branch can't hide a change by editing the pattern that would catch it. The other settings come from HEAD.

**Run IDs.** A run ID is the work item made path-safe, followed by `-r{n}`. For example, `#42` gives `#42-r1`, and `fusupo/escapement#42` gives `fusupo-escapement#42-r1`. The work item can be any external identifier.

### start

- The run is bound to the worktree and the branch it is on. A worktree can have one open run at a time (`run_exists`).
- Starting on the run's target branch is blocked with `on_target_branch` (exit 2): the authorization would cover commits to it. An `origin/` prefix on `--target-ref` is ignored in the comparison. Check out a feature branch first. A refused start creates no run and no artifact dir.

### approve

- The contract must validate against `schemas/factory/contract.schema.json`, with unique criterion and evidence IDs. Its `run_id` must be this run, and its `issue`, if set, the run's issue. Otherwise `bad_contract` lists every problem.
- A contract names no commands. Checks come only from settings, so a contract can't skip or narrow a required check.
- The digest is the `sha256:` hash of the contract file's bytes.
- The first approval sets `deadline_at` to `approved_at` plus `--run-budget`, and `max_attempts` to the worktree's `max-attempts` setting. Later approvals never move either, and the fix loop, `validate` and `continue` use the recorded budget, so a later commit to the branch's settings can't change it (#92).
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

**3. setup.** Runs when `setup` is configured and the lockfile digest differs from the last successful setup in this run, which is always the case on the first attempt. If `setup` is a required check, it runs on every attempt. A failed setup makes the attempt `error`, caused by the environment.

**4. static.**
- Runs the `static` command; a non-zero exit fails the phase.
- **Change classification** over the full diff `merge_base..head`, against git's tree at the merge base:
  - new evidence: a new test file, or a hunk that only adds a new test block (`it(`, `test(`, `describe(`, `def test_`, `func Test`, `#[test]`, `@Test` and similar);
  - modified assertion: a changed or removed line in an existing test file, a deleted test file, an added `skip`, `only` or `todo` marker, or any other addition, since ambiguous cases count as modified;
  - execution policy: a changed `validation-files` file, or changed factory settings in `CLAUDE.md`, including a dropped required check.
- Test files are those matching `test-files`, plus the files the contract's test selectors name. Renames count as a delete plus an add.
- Each modified assertion and policy change becomes an advisory finding (`assertion:{file:line}`, `policy:{path}`) that the reviewer must address (see record-review).
- **Tier** from the actual diff: a sensitive path or a policy change makes it `sensitive`, whatever the contract proposed.
- **Drift:** changed files the contract didn't predict, and predicted files left unchanged, become flags.

**5. evidence.**
- **verify** runs once. Each invocation gets a new, empty `attempts/{n}/results/{id}/` directory as `FACTORY_RESULTS_DIR`. `test-results` should point into it, for example `junit:$FACTORY_RESULTS_DIR/junit.xml`, or at a directory of `.xml` files.
- A `test-results` path outside that directory is a **fixed path**. It must be gitignored. It is deleted before verify and must exist afterwards with a fresh mtime; it is then copied into the results directory.
- Missing results, results that aren't JUnit XML, or results with zero executed tests make the phase `error`, never `pass`, whatever verify's exit status.
- **test evidence** resolves `path::name` against the results: a case in that file (by its `file` attribute, a path-like classname or suite name, or pytest's dotted classname) whose name, or the end of its full name, is `name`. `*` is a wildcard, and a bare path selects every test in the file. No match is `not_found`; skipped and not_found are failures.
- **Results without file paths.** Some reporters write no path: node:test's `junit` reporter (`classname="test"`), and jest-junit unless `addFileAttribute` is on (`JEST_JUNIT_ADD_FILE_ATTRIBUTE=true`). A `path::name` selector that matches nothing by path may then match such cases by name alone, as long as the selector's file exists at `head_sha`. Cases that name another file never match this way, and a bare path never does. The report flags each name-only match, so the reviewer can check the test is in that file. Test cases written directly under `<testsuites>`, as node:test does for tests outside a `describe`, are read too.
- A test that verify doesn't run is `not_found`. The runner can't run a single test on its own, because contracts name no commands.
- **command evidence** runs on its own, in `cwd` (inside the worktree), checking `expect.exit_code`, `stdout_matches` and `stdout_not_matches`.
- **manual evidence** is `pending_manual`.
- A failed item, or a non-zero verify exit, fails the phase.

**6. Post-check.** After the last command, HEAD must still be `head_sha` and the tree clean. Otherwise the attempt is `error`: "revision changed during validation" (caused by the run) or "checks are not side-effect free" (caused by the code).

**7. Report and transitions.**
- The report goes to `attempts/{n}/report.json` (`schemas/factory/report.schema.json`). Its `invocations` list binds each log and results file, with its digest, to the command that produced it.
- All phases pass (or the evidence phase is `pending_manual`): the attempt is `awaiting_review` with outcome null, and the run stays `validating` until `record-review` records a verdict.
- A failure or error completes the attempt (`fail` or `error`), and the fix loop (design §6.2) moves the run on: back to `implementing` when the implementer can fix it, else `escalated`. The result's `run_state` and `run_reason` say which and why:

| `run_reason` contains | Run | When |
|---|---|---|
| `fix_loop` | `implementing` | a `fail`, or an `error` caused by the code or the run, with attempts left |
| `run_deadline` | `escalated` | the run deadline has passed |
| `needs the operator` | `escalated` | an `error` caused by the environment |
| `attempt_budget` | `escalated` | the run's attempt budget (`max-attempts`, fixed at approval) is used, interrupted attempts included |
| `needs_operator` | `escalated` | a blocking `signoff:` or `justification:` finding, or a `judgment:` finding on manual evidence (`evidence_type: manual`: a rejected procedure, which only a re-approved contract can change), after review |
| `stuck` | `escalated` | a check or evidence finding with the same `evidence_digest` as in the attempt before |

- **Error causes.** An `error` attempt's report has `error: {cause, reason}`, and the attempt row has `error_cause` and `error_reason` (`status`). `code`: a check timed out or hung, the checks wrote into the tree, or verify's results are missing, unreadable or empty. `run`: HEAD moved or the tree changed during validation, or before review. `environment`: a check couldn't start (`spawn_failed`), `setup` failed, a command evidence `cwd` is outside the worktree, or a runner error. `validate` returns it as `error`. When the runner itself fails mid-attempt, it still writes `report.json` (outcome `error`, a blocking `runner` finding, the invocations so far) before the command fails.
- **Regression flags.** Evidence that passed in an earlier attempt of the run and doesn't pass now is flagged `regression: evidence {id} passed in attempt {k} and is {executed} now`.
- Phases stop at the first failure; evidence after a static failure is `not_run`.

Commands run in the worktree with `FACTORY_RUN_ID` and `FACTORY_ATTEMPT` set, under the per-command timeout and the run deadline, like exec.

### review-input

`review-input <run_id> <attempt> [--issue-file <file>]` prepares the review (§4.9) of an attempt awaiting review. It holds the worktree lock. Like exec it starts work, so it refuses past the run deadline and on a halted run, and it needs an active authorization.

1. The attempt must be `awaiting_review` (otherwise `wrong_state`) and `contract.json` must still have the digest the attempt was validated with (`contract_mismatch`).
2. HEAD must still be the attempt's `head_sha` on a clean tree. Otherwise the attempt completes as `error`, caused by the run: its report becomes final, with the error and an `identity` finding (the draft is kept as `report.draft.json`). The run moves on by the fix loop's rules, normally back to `implementing`, and the command fails with `revision_changed`.
3. It writes `attempts/{n}/review/`:
   - `source/`: `git archive head_sha`, with read-only files. Its digest (`sha256:` over each file's path, type and content) is recorded in a `state_change` event (entity `review`, to `issued`).
   - `diff.patch`: `git diff merge_base_sha..head_sha`.
   - `issue.md`: a copy of `--issue-file`. The runner never fetches issues; without the flag the bundle's `issue` is null, unless an earlier call gave one.
   - `bundle.json`: everything the reviewer reads (below).

Calling it again for the same attempt, for example when `resume` reports `reissue_review`, keeps the snapshot if its digest is unchanged and re-exports it otherwise.

**The bundle** (`bundle.json`):

| Field | Holds |
|---|---|
| `run_id`, `attempt`, `head_sha`, `merge_base_sha`, `target_ref`, `target_sha` | The attempt and its revisions |
| `issue` | `{path}` of `issue.md`, or null |
| `contract` | `{path, digest, content}` |
| `diff` | Path of `diff.patch` |
| `source` | `{path, digest}` of the snapshot. The reviewer reads this, never the live worktree |
| `report` | `{path, tier, changes, flags}` of the draft report |
| `logs`, `results` | Absolute paths of every log and results file |
| `required` | What a complete verdict must cover (below) |
| `verdict` | `{schema, write_to, record}`: the verdict schema, where the reviewer writes the verdict (`review/verdict.json`), and the shell-quoted `record-review` command for the host to run |
| `runner` | `{path, exec}`: `scripts/factory.sh`, and the shell-quoted prefix for any command the reviewer runs |
| `reviewer_prompt` | Path of `prompts/factory/validation-reviewer.md` |

The commands in `verdict.record` and `runner.exec` carry `--data-dir` naming the database the bundle was written from, so they work from a shell whose environment lacks `ESCAPEMENT_MANIFEST_DIR`.

**Required judgments** (`required`), computed the same way by `record-review`:
- `evidence`: every contract evidence ID with its criterion, type, the draft's `executed` result, its selector, command or instructions, and the judgment it takes: `supports_criterion` for test and command evidence, `procedure_adequate` for manual evidence.
- `sensitive_paths`: every changed file matching `sensitive-paths` at the merge base or HEAD, and every execution-policy change (`policy:{path}`), each with its reasons. Both need a sign-off.
- `modified_assertions`: every `assertion:{file:line}` location.

**The reviewer** is data, so any runtime can run it: `prompts/factory/validation-reviewer.md` plus `schemas/factory/verdict.schema.json`. `factory prompt reviewer` prints the prompt's path, or its content with `--print`. The Claude Code agent `agents/validation-reviewer.md` reads the prompt named in the bundle and follows it. The reviewer writes the verdict; the host records it.

### record-review

`record-review <run_id> <attempt> <file>` records a verdict (`-` reads it from stdin). It holds the worktree lock. It is bookkeeping, so it works past the run deadline for a review in progress; it refuses only a closed run.

1. **Shape.** The verdict must be JSON valid against `schemas/factory/verdict.schema.json`. Otherwise `invalid_verdict`.
2. **Completeness** (§4.9), against the required judgments. Otherwise `incomplete_verdict`, listing every problem:
   - `source_digest` is the digest `review-input` issued for this attempt (no review issued: `not_issued`);
   - every required evidence ID is judged exactly once, with the judgment its type takes, and no unknown ID;
   - every required sensitive path has exactly one sign-off, and no other path does;
   - every modified-assertion location has exactly one justification, and no other location does.

   A rejected verdict changes nothing: no file is written and the attempt stays `awaiting_review`. The rejection is logged as a `state_change` event (entity `verdict`, to `rejected`).
3. **Identity.** HEAD must still be `head_sha` on a clean tree, as for review-input (`revision_changed`).
4. **Finalization.**
   - The verdict is stored as `attempts/{n}/review.json`, its digest goes on the attempt, and the attempt moves to `finalizing`.
   - The draft report is kept as `report.draft.json`.
   - `report.json` becomes the final report: `status: complete`, the outcome, each evidence item's judgment and `rationale`, a `review` phase, and a `review` block with the verdict and source digests, the sign-offs and the justifications.
   - The attempt completes, and a `validating` run moves on.

**Outcome:**
- `fail` on any `supports_criterion` of `no` or `partial`, `procedure_adequate` of `no`, sign-off `concern`, `justified: false`, or blocking finding. Each one becomes a blocking finding in the report: `judgment:{id}`, `signoff:{path}`, `justification:{location}` or `review:{n}` (the verdict's own findings, in order). A `judgment:{id}` finding carries `evidence_type`, the judged item's contract type (`test`, `command` or `manual`), so the fix loop can tell a rejected manual procedure from evidence the implementer can improve (#99).
- Otherwise `pending_manual` when the contract has manual evidence, else `pass`.
- `pass` and `pending_manual` move the run to `validated`, so a PR can open while a human records the manual outcomes (`record-manual`). `fail` goes to the fix loop, as for validate (the `run_reason` table there): back to `implementing`, or `escalated` for a refused sign-off, an unjustified assertion or a rejected manual procedure. A run that was halted meanwhile (for example by the deadline) keeps its state.

**Idempotency.** The verdict digest is the `sha256:` of its canonical JSON (keys sorted), so formatting doesn't matter.
- The same verdict for a `complete` attempt is a no-op (`noop: true`). A different one is `verdict_conflict`.
- The same verdict for a `finalizing` attempt, left by a crash, finishes the finalization (`refinalized: true`). This is what `resume`'s `refinalize` asks for. A different one is `verdict_conflict`.
- An attempt that completed without review (a deterministic failure) takes no verdict (`wrong_state`).

### check

`check` is the mechanical half of the readiness check (§3.1), for a planner to run before `start` or `approve`. It reads the contract and the settings of `--project-root` (default: the current worktree; a detached HEAD is fine, since no branch is needed) and reports `needs_human` with a question for each gap:

- the contract is invalid (each problem), has no criteria, or has a criterion without evidence;
- a required check has no command configured;
- a setting is invalid;
- the contract has `test` evidence but the project sets no `test-results`.

Whether the criteria capture the intent, and whether scope and dependencies are clear, is the planner's judgment; it adds those questions in the same shape. `check` exits 0 for both `ready` and `needs_human`; read `status`.

Without `--contract`, `check` reports only the settings: a required check with no command, or an invalid setting. There are no contract questions and no `tier`. A host can run it before planning to see whether the project is set up for the factory at all; `setup-work` offers a run only when it is `ready`, and branches from its `target_ref`.

The manifest mirrors a readiness document into a work item with `manifest.sh readiness <owner/repo> <issue> <file|->`: `needs_human` sets `meta.needs_human` and `meta.readiness_questions`, so the item leaves the frontier, and `ready` clears them. It does nothing when the issue has no work item.

### check-critique

`check-critique <file> [--final]` checks a plan critique (`-` reads it from stdin) against `schemas/factory/critique.schema.json` and the rules a schema can't express (design §3.5, #99). It needs no run and no database: the critique happens before plan approval creates the run.

- Every checklist item is judged exactly once, as `ok` or `concern`, and every `concern` has a finding naming that item.
- Finding IDs (`F-1`, `F-2`, …) are unique.
- `approve` carries no `blocking` finding; `revise` and `escalate` carry at least one finding.
- Each disposition names a finding of the critique, at most once. An accepted finding names its `plan_change`; a rejected one gives its `reason`.
- With `--final`, every finding has a disposition.

A bad document is `bad_critique` (exit 1), listing every problem. The critic is data like the reviewer: `prompts/factory/plan-critic.md` (`factory prompt critic`) and the critique schema, with the Claude Code agent `agents/plan-critic.md` as a thin wrapper. The host writes the critic's brief (`setup-work` Phase 3.55 lists its fields) and adds the dispositions after the critique round.

### record-critique

`record-critique <run_id> <file>` attaches the final critique (`-` reads stdin) to the run plan approval created. It checks the document as `check-critique --final` does (`bad_critique`, nothing written), then:

- writes `{artifact_dir}/critique.json`;
- records one `critique_finding` event per finding (design §7.2): `{finding, severity, checklist, ref?, accepted, plan_change, reason, unresolved, decided_by, tokens}`, with `tokens` null since hosts don't report them;
- records a `state_change` event with `entity: critique`, the critique's digest, verdict and finding count.

The digest is the `sha256:` of the critique's canonical JSON. The same critique again is a no-op (`noop: true`), or finishes a recording a crash interrupted after `critique.json` was written; a different one is `critique_conflict`. A closed run is refused (`run_closed`).

### exclude

`exclude <pattern>…` appends each pattern to the repository's `info/exclude` (from `git rev-parse --git-path info/exclude`, shared by every worktree of the repository), unless an identical line is already there. Patterns use `.gitignore` syntax. Empty or multi-line patterns, comments (`#…`) and negations (`!…`) are refused with `bad_pattern`: none of them excludes anything, and a negation could make ignored files count as untracked. The project's `.gitignore` is never touched.

The runner knows no host's file names. `setup-work` passes `'SCRATCHPAD_*' 'SESSION_LOG_*' AGENT_CONSTRAINTS.md`.

### authorization

`authorization [--project-root <path>]` answers the one question skills ask before they skip a confirmation (§3.6): does this worktree have a run whose active authorization covers it? It looks up the worktree's non-closed run and is **matched** only when all hold:

- the run's repo and branch are the worktree's current repo and branch;
- the run has an active authorization;
- `{artifact_dir}/contract.json` hashes to the authorized digest, which is also the run's;
- the run is `approved`, `implementing`, `validating`, `validated` or `pr_open`, not waiting on a human;
- the run deadline hasn't passed.

Otherwise `reasons` lists each one that failed: `no_run`, `repo_mismatch`, `branch_mismatch`, `no_active_authorization`, `contract_missing`, `contract_changed`, `run_halted`, `run_deadline`. Outside a repository it is `not_a_repo`, on a detached HEAD `detached_head`, and when the manifest database doesn't exist `no_database`: it never opens or creates the database, and never changes the run, even past the deadline. It exits 0 either way; route on `matched`.

A matched answer carries the run, what the authorization allows (`authorizes`) and an advisory `next`:

| `next` | When |
|---|---|
| `implement` | the run is `approved` or `implementing`: nothing is being validated. After a failed or errored attempt, `fix` says what to fix |
| `validate` | the run is `validating` without a usable attempt: the last one was interrupted (a crash during checks), or none was allocated. Validate again |
| `resume` | the latest attempt is left mid-way (checks running or crashed, or finalizing after a crash), or a complete attempt's run transition is still owed: run `resume` and follow its actions |
| `review` | the latest attempt awaits review |
| `pr` | the run is `validated` |
| `refresh_pr` | the run is `pr_open`, and its report changed since `pr` last wrote the description (a manual outcome resolved it) |
| `await_merge` | the run is `pr_open` and the PR shows the current report: nothing to do until the operator merges |

The runner still checks every command on its own; `next` only tells a host where to pick up.

**`fix`** is set while the run is `implementing` after a completed `fail` or `error` attempt, whether the fix loop or `continue` brought it back, and null otherwise: `{attempt, outcome, error, blocking_findings, report_path}`. `error` is `{cause, reason}` for an error attempt. `blocking_findings` are the attempt's blocking findings (`id`, `detail`, `location`). The implementer works from these (design §6.2: findings only).

### escalate

`escalate <run_id> --reason <text>` moves a run to `escalated`, so it shows why it stopped instead of looking active: the host hit something it can't get past, such as a blocked precondition or a real blocker. A run already blocked or escalated is left as it is (`changed: false`). It works past the deadline and refuses a closed run.

### continue

`continue <run_id> --reason <text>` takes an `escalated` run back to `implementing`, under the same contract, digest and authorization (design §6.2). The operator decides; skills offer it in plain words and run it. The deadline and the attempt budget are never reset, and the next `validate` is a new attempt.

Refused, blocked (exit 2), and nothing changes, when:

| Code | When |
|---|---|
| `run_deadline` | the run deadline has passed: going on needs a new run and budget |
| `not_authorized` | the run has no active authorization |
| `contract_mismatch` | `{artifact_dir}/contract.json` is missing or no longer has the approved digest |
| `has_pr` | the run already has a PR. A failed manual check escalates a `pr_open` run with the attempt's outcome set to `fail`, but going back after the PR opened isn't supported yet (#97) |
| `no_failed_attempt` | the latest attempt isn't a completed `fail` or `error`, or there is none |
| `attempt_budget` | every attempt (`max-attempts`) is used |

A run that isn't `escalated` is `wrong_state` (exit 1); a blocked run can only be closed. Any error cause is accepted: the operator judges whether the environment is fixed. A run already back in `implementing` after that attempt is left as it is (`changed: false`). The result names the attempt to fix, its outcome and error, and the attempts used of `max_attempts`.

### GitHub and the agent identity

Everything the factory does on GitHub runs as the AI agent's GitHub account, so its work shows as the agent's and not the operator's:

| Variable | Use |
|---|---|
| `ESCAPEMENT_AGENT_GH_TOKEN` | Required for `pr`, `push`, and `archive --close` with a PR. The agent account's token |
| `ESCAPEMENT_AGENT_NAME`, `ESCAPEMENT_AGENT_EMAIL` | Optional. The agent's commit author. Default: the token account's login and its GitHub noreply address (`{id}+{login}@users.noreply.github.com`) |

**Where they come from.** Each variable is read from the environment, or else from the user's `${XDG_CONFIG_HOME:-~/.config}/escapement/agent.env`, so nothing needs exporting before the host starts:

```
ESCAPEMENT_AGENT_GH_TOKEN=ghp_…
ESCAPEMENT_AGENT_NAME=Escapement Agent        # optional
ESCAPEMENT_AGENT_EMAIL=agent@example.com      # optional
```

- `KEY=value` lines; `export ` and matching quotes are allowed, `#` starts a comment. Only these three keys are read; anything else in the file is ignored.
- A variable set in the environment wins over the file.
- Like an ssh key, the file is refused (`agent_env_permissions`) while group or others can read it: `chmod 600` it.
- The identity is the user's, not a project's, so the runner never reads a project's `.env`.

- The token reaches `gh` as `GH_TOKEN` (`GITHUB_TOKEN` is dropped), and `git push` through a credential helper that reads the variable, only ever for github.com: a push to any other host is refused with `not_github` (`pr` and `push` alike). It never appears in argv, URLs, logs, events or JSON output; errors redact it.
- Without it, `pr`, `push` and `archive --close` are blocked with `no_agent_token`. The runner never falls back to the operator's own `gh` login; a plain skill may (see [push](#push)).
- Keep the token out of any file a project commits.
- `agent` prints the commit identity (`{name, email, login, source}`, `source` being `env` or `github`). Skills commit with it, under an authorization and on the plain path alike: `git -c user.name=… -c user.email=… commit`.
- The `gh` CLI must be on PATH (`gh_missing` otherwise).

**Skills use the same identity.** The runner is the only Escapement component that calls `gh`, and always with the agent token. Skills never call `gh` (it is logged in as the operator): they reach GitHub through the GitHub MCP tools, which are authenticated as the agent account, push with `push`, and commit with `agent`'s identity (FACTORY_DESIGN.md §4.8).

### push

`factory push` pushes the worktree's current branch as the agent, with no run and no database. It is how a plain skill (create-pr, do-work's push reminder) pushes, instead of a `git push` that would carry the operator's credentials.

- HEAD goes to `refs/heads/{branch}` and nothing else, never forced, through the same path as `pr`'s push: to `https://github.com/{repo}.git` with the agent token from a credential helper, or as configured on a local remote. Project `pre-push` hooks still run. Afterwards `refs/remotes/origin/{branch}` points at the pushed commit and the branch tracks it (upstream `origin/{branch}`).
- Refused (`push_base_branch`): the project's base branch (`base-branch` setting, else `develop` when origin has it, else `main`), origin's default branch (`refs/remotes/origin/HEAD`, when known), `main` and `master`. A detached HEAD is `detached_head`. It takes no arguments (`usage`).
- **The agent token goes to github.com only.** An origin on any other host (GitLab, a self-hosted server, GitHub Enterprise) is refused with `not_github` before the token is read. A local remote never gets the token.
- Without the agent token it is `no_agent_token` and nothing is pushed. The runner never falls back; the skill decides. On `no_agent_token` or `not_github`, Escapement's skills push with the operator's `git push` and say so in one line. On `agent_env_permissions`, `push_failed` or `no_remote` they report and stop, never retrying as the operator.

### pr

`pr <run_id> [--title <t>] [--body-file <f>]` opens the run's PR, or updates it, idempotently (§4.8). It holds the worktree lock.

1. **Checks.** The run is `validated`, or `pr_open`, or `escalated` with a PR already recorded (a refresh). Otherwise `not_validated`. Then:
   - an active authorization allowing `push_branch` and `open_pr` (`not_authorized`);
   - `contract.json` is the approved contract (`contract_mismatch`);
   - the current report, the latest complete attempt's highest revision, exists (`no_report`), is `pass` or `pending_manual` when creating (`not_validated`), and is for the approved contract (`stale_report`);
   - HEAD equals the report's `head_sha` and the tree is clean (`head_moved`: validate again).
2. **Lookup.** `gh pr list --head {branch} --state open`, keeping PRs from the run's repository (a fork's PR with the same branch name is ignored). Two open PRs: `pr_conflict`. A recorded number that isn't the open PR: `pr_conflict`. A recorded PR that is no longer open: `pr_not_open`.
3. **Create or update.** With no open PR, creating needs `--title` (`usage`) and the deadline not passed (otherwise the run escalates: `run_deadline`). The runner pushes HEAD to `refs/heads/{branch}` and nothing else, never forced, then runs `gh pr create --base {target_ref} --head {branch}`, or updates the PR with `gh api -X PATCH repos/{repo}/pulls/{number}` (not `gh pr edit`, which also queries classic Projects and fails where they are deprecated). On a GitHub remote the push goes over https as the agent, whatever protocol `origin` uses; a local remote is pushed as configured. Project `pre-push` hooks still run.
4. **Record.** The PR number goes on the run, with a `state_change` event (entity `pr`), and a `validated` run moves to `pr_open`.

**The description** is the host's narrative (`--body-file`; on update without it, the PR's current description) plus the runner's report section, between `<!-- escapement:factory-report:begin -->` and `<!-- escapement:factory-report:end -->`. Updates replace only the section. It shows the outcome, the run and attempt (and report revision), the actual and proposed tier with reasons, what was validated (the branch, not the merge result), the contract digest, a table of every criterion's evidence with its result and judgment, manual checks (pending or recorded), findings and flags. Text from reports is escaped, so it can't break the table or forge a marker. The final description is kept at `{artifact_dir}/pr/body.md`.

**Crashes.** Running `pr` again after a crash at any step is safe: the lookup finds a PR an earlier call created, and the same number is recorded once. Its `action` is then `recovered`. Recovery is "run the command again"; `resume` doesn't touch PRs.

Updating an existing PR is bookkeeping: it works past the deadline, and for an `escalated` run with a PR, so its description stops showing a stale report.

### record-manual

`record-manual <run_id> <evidence_id> pass|fail --note <text> [--recorder <name>] [--assisted [--attachment <file>]...]` records a human's outcome for `manual` evidence that the current report left `pending_manual` (§5.5). It holds the worktree lock and works past the deadline.

- **Bound to the report.** The report must be for the approved contract (`stale_contract`) and HEAD must still be its `head_sha` (`stale_report`); a new commit invalidates earlier records along with the report. The evidence must be one awaiting a human (`unknown_evidence`, listing those that are). A report that isn't `pending_manual` refuses with `not_pending_manual`, or `already_resolved` once human outcomes decided it.
- **Records.** Each is a `manual_outcome` event with the outcome, note, recorder, head and contract. The same outcome again is a no-op; a different one replaces it until the report resolves.
- **Agent-assisted (#103).** `--assisted` marks an outcome the human decided from the agent's walk-through (`validate-work`'s **Carrying Out a Manual Check**). Each `--attachment` names one of the agent's files, which must exist and lie under `{artifact_dir}/manual/{evidence_id}/` (else `bad_attachment`); it is stored relative to the artifact dir. `--attachment` without `--assisted` is a usage error. The recorder is still the human: the OS user, or `--recorder`. A record is a no-op only when the outcome, the assisted mark and the attachment list are all unchanged. The event and the revision's `manual_outcomes` carry `assisted: true` and `attachments`; unassisted records carry neither, as before.
- **Before it resolves.** The result's `recorded` lists every outcome recorded so far for the report (with `recorder`, `note`, `assisted` and `attachments`). `status` shows them too (`.result.manual`: `pending` and `recorded`, null when the current report isn't pending), and `pr` shows each in the PR's report section as recorded, with the others still awaiting a human. So a run's checks can be worked through one at a time.
- **Record every check of a run with the same runner version.** An older runner writes the final revision without the assisted fields.
- **Resolution.** When every manual item is `pass`, or any is `fail`, the runner writes the next revision, `attempts/{n}/report.r{k}.json`: `revision`, `supersedes`, the new `outcome`, the manual evidence marked `passed` or `failed`, and `manual_outcomes`. Earlier revisions, `report.json` included, are never changed, and the attempt's outcome follows. A `fail` adds a blocking finding `manual:{evidence_id}` with the note and escalates the run.
- `refresh_pr: true` in the result means the run's open PR shows an out-of-date report section: run `pr` again. Since #103 it is set after any new record, not only when the report resolves.

### archive

`archive <run_id> --path <dir> [--close | --abandon]` records where the host archived the run (`archive_path`) and can close it, so its worktree can start another run. It holds the worktree lock and works past the deadline.

- `--close` takes the action from the run's PR, read as the agent: merged → `merged`; closed unmerged, or no PR at all (no GitHub call) → `abandoned`; still open → `pr_open`, nothing recorded.
- `--abandon` closes the run as `abandoned` without asking GitHub.
- Closing ends the authorization. The artifact dir stays where it is: the database records its paths. The merge commit and other operator actions are recorded later (manifest-sync).
- The same path again, or closing a closed run, changes nothing.

### The exec guard

While a run is implemented, builds and tests should go through `exec`, so they queue on the build lock. The plugin's `PreToolUse` hook `hooks/factory-exec-guard.sh` enforces that for Claude Code's Bash tool.

- **The marker.** The runner keeps `$(git rev-parse --git-path escapement-factory-run.json)` (per worktree, inside `.git`, so the tree stays clean) exactly while the run is `approved`, `implementing` or `validating` under an active authorization, `exec-hook` is `on` (the default), and `static` or `verify` is configured. It holds `{version, run_id, worktree_path, deadline_at, commands}`, the commands being the settings' `static` and `verify`. The CLI re-syncs it after every command that names a run, failures included, so it follows each transition, revocation and close; `resume` heals one a crash left behind.
- **The hook.** With no marker it exits at once (one `jq` and one `git` call). With one, it splits the command on `&&`, `||`, `;`, `|` and newlines; a part that starts with a guarded command (after environment assignments, `time`, `command`, `nohup` or an opening parenthesis) is refused, with the exact `exec` command to use. It ignores a marker past the run deadline and lets the call through on anything unexpected, such as no `jq` or a malformed marker.
- **Opting out.** `exec-hook: off` in the project's Escapement Settings: the runner then writes no marker.
- It guards against forgetting, not against an adversary (§11): `npx jest` instead of `npm test` gets through.

## Locks

Locks are rows in `factory_locks`, not `flock`s. They only serialize factory commands; anything outside the factory ignores them.

| Lock | Guards | Held by |
|---|---|---|
| `build` | CPU: one build or test at a time across all worktrees (per user, since the DB is per user) | `exec` while its command runs; `validate` throughout |
| `worktree:{path}` | One factory operation at a time on a worktree | `exec`, `validate`, `review-input`, `record-review`, `resume`, `pr`, `record-manual`, `archive` |

Each row records its holder: pid, process start time, command, host and run.
- A holder whose process is gone, or whose pid now belongs to another process, is treated as dead.
- The next caller takes a dead holder's lock over and logs the takeover as an event.
- `resume` also removes dead holders' locks.
- While `exec` or `validate` runs a command, the build lock's row also records the command's process group. A runner that dies mid-command leaves that group running; whoever takes the dead holder's lock over, or `resume`, kills the group first (`killed_groups` in resume's result). The group leader's start time guards against a reused pid.

Locks are always taken worktree first, then build.

## Resume rules

`resume` holds the worktree lock and, for each attempt:

| Found | Action reported | Change |
|---|---|---|
| `checks_running`, owner dead | `interrupted` | attempt → `interrupted` (still counts toward the attempt budget) |
| `checks_running` or `finalizing`, owner alive | `running` | none |
| `awaiting_review`, identity changed (HEAD moved or tree dirty) | `identity_error` | attempt → `complete`, outcome `error` caused by the run, with a final report |
| `awaiting_review`, no verdict file | `reissue_review` | none: the caller runs `review-input` again |
| `awaiting_review`, verdict file present (`review.json`, or the reviewer's `review/verdict.json`) | `record_review` | none: the caller runs `record-review` with that file |
| `finalizing`, verdict file present | `refinalize` | none: the caller runs `record-review` with `review.json`, which finishes the finalization |
| `finalizing`, no verdict file | `needs_attention` | none |
| latest attempt `complete`, run still `validating` | `advanced_run` | run → its next state by the fix loop's rules (see validate, step 7): `validated` (pass or pending_manual), `blocked` (blocked), back to `implementing`, or `escalated`; `detail` gives the reason |

For the review actions, `detail` is the command to run (run ID and path single-quoted) and `file` the verdict file it records. Past the deadline, resume still reconciles, escalates the run, and starts nothing. It never resets a budget.

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
- **review-input:** `{run_id, attempt, bundle_path, source_digest, reused_snapshot, required: {evidence, sensitive_paths, modified_assertions}}` (counts)
- **record-review:** `{run_id, attempt, status, outcome, report_path, verdict_path, verdict_digest, run_state, noop, refinalized}`
  - `outcome` is `pass`, `fail` or `pending_manual`.
- **status** with a run ID: `{run, deadline_passed, authorization, authorizations, attempts, locks}`
- **status** without one: `{runs: [run, …]}`
- **resume:** `{run, deadline_passed, actions: [{attempt, found, action, detail?, file?}], released_locks, killed_groups}`; `file` is the verdict file for `record_review` and `refinalize`
- **revoke:** `{authorization}`
- **escalate:** `{run, changed}`
- **authorization:** `{matched: false, reasons, run_id, state}`, or `{matched: true, reasons: [], run_id, state, repo, branch, target_ref, worktree_path, artifact_dir, contract_path, contract_digest, authorizes, approved_at, deadline_at, issue_number, pr_number, latest_attempt: {attempt, status, outcome, head_sha} | null, next}`
- **agent:** `{name, email, login, source}`
- **push:** `{branch, sha, repo, remote}`; `remote` is the URL pushed to, never with the token
- **pr:** `{run_id, pr_number, url, action, state, head_sha, attempt, report_revision, outcome, body_path}`; `action` is `created`, `updated` (the recorded PR) or `recovered` (an unrecorded PR an earlier, interrupted call created)
- **record-manual:** `{run_id, attempt, evidence_id, outcome, noop, recorded: [{evidence_id, outcome}], pending, resolved, report_path, report_revision, run_state, pr_number, refresh_pr}`; `resolved` is null until the report resolves
- **archive:** `{run_id, archive_path, changed, closed, pr_state, state}`; `closed` is `merged`, `abandoned` or null
- **exclude:** `{path, added, present}`: the exclude file, the patterns appended, and those already there
- **check-critique:** `{valid, final, verdict, findings: {blocking, major, minor}, concerns, tier_raise, dispositions, unresolved}`; `concerns` lists the checklist items judged `concern`, `dispositions` counts them, and `unresolved` lists the findings the operator decided
- **record-critique:** `{run_id, path, digest, verdict, findings, accepted, rejected, unresolved, noop}`
- **check:** a readiness document (`schemas/factory/readiness.schema.json`): `{version, status, questions: [{about, question, ref?}], tier?: {tier, reasons}, required_checks: [{name, command}], target_ref, settings_digest}`. `target_ref` is the branch `start` targets without `--target-ref`; hosts create the feature branch from it
- **schema:** `{schemas: [{name, path}]}`, or `{name, path}`, plus `schema` with `--print`
- **prompt:** `{prompts: [{name, path}]}`, or `{name, path}`, plus `content` with `--print`

Run fields:
- `run_id`, `work_item`, `repo`, `worktree_path`, `branch`, `target_ref`, `artifact_dir`
- `deadline_at`
- `issue_number`, `manifest_id`, `work_type`
- `state`, `state_reason`
- `tier_proposed` (from the contract, set by approve), `tier_actual` and `policy_version` (set by validate)
- `contract_digest`, `operator_action` (the close action)
- `pr_number` (set by pr), `archive_path` (set by archive), `merge_sha` (null until manifest-sync records it)
- `started_at`, `ended_at`

The remaining §7.1 columns appear too and stay null until later issues fill them.

Run states:
- `planned`, `approved`, `implementing`, `validating`, `validated`, `pr_open`
- `closed`: terminal
- `blocked` and `escalated`: waiting on a human

Error codes:

| kind | codes |
|---|---|
| `blocked` (exit 2) | from start `on_target_branch`; `run_deadline`, `not_authorized`, `run_halted`, `run_closed`, `lock_timeout`, `attempt_budget`; from validate also `attempt_open`, `bad_setting`, `contract_mismatch`, `not_configured`, `dirty_tree`, `no_target`, `no_merge_base`; from review-input and record-review also `contract_mismatch`, `not_issued`, `invalid_verdict`, `incomplete_verdict`, `verdict_conflict`; from pr `not_validated`, `no_report`, `stale_report`, `head_moved`, `pr_conflict`, `pr_not_open`, `no_agent_token`; from record-critique `critique_conflict`; from record-manual `no_report`, `not_pending_manual`, `already_resolved`, `stale_report`, `stale_contract`, `unknown_evidence`; from archive `pr_open`, `no_agent_token`; from agent `no_agent_token`; from pr and push `not_github`; from push `push_base_branch`, `no_agent_token`; wherever the agent identity is read, `agent_env_permissions` |
| `error` (exit 1) | `usage`, `no_such_run`, `run_exists`, `wrong_state`, `illegal_transition`, `no_contract`, `bad_contract`, `bad_critique`, `bad_setting`, `no_active_authorization`, `bad_duration`, `bad_work_item`, `bad_project_root`, `not_a_repo`, `detached_head`, `git_failed`, `no_such_attempt`, `revision_changed`, `snapshot_failed`, `unreadable`, `bad_pattern`, `gh_missing`, `gh_failed`, `push_failed`, `no_remote`, `internal` |

## Fault injection (testing only)

Crash tests (`scripts/test-factory.sh`, and the first-release acceptance run, #65) make the runner die at an exact point with an environment variable. It does nothing when unset.

- `ESCAPEMENT_FACTORY_FAULT`: a comma-separated list of points, each `point` or `point@N` (the Nth time the point is reached in one process; default the first). At the point the runner writes `factory: fault injected at {point}` to stderr and SIGKILLs itself: no cleanup, no lock release, no JSON, exit status 137. A mistyped point is a `usage` error before the command runs.
- `ESCAPEMENT_FACTORY_FAULT_DIR`: makes each point fire once across processes. Firing leaves `{dir}/{point}.fired`, and a point whose file exists is skipped, so one session can arm several points and still resume past each.

| Point | Where | Left behind | Picked up by |
|---|---|---|---|
| `validate.before_check` | before each check starts; `@N` counts them in run order: setup, static, each `command` evidence, verify | attempt `checks_running`, owner dead | `resume` → `interrupted`; `next` is `validate` |
| `validate.report_written` | the attempt's `report.json` written | attempt `checks_running` | the same |
| `validate.committed` | the attempt moved to `awaiting_review` (or `complete`, and the run moved on), before output | the host saw no result | `next` is `review`; `resume` → `reissue_review`. After a failed attempt the run is already back in `implementing`: `next` is `implement`, with `fix` |
| `review-input.issued` | the bundle written and issued | as before the call | `resume` → `reissue_review`; `review-input` reuses the snapshot |
| `record-review.verdict_stored` | `review.json` stored, attempt `finalizing` | attempt `finalizing` | `next` is `resume`; `resume` → `refinalize`; `record-review` with its `file` |
| `record-review.report_written` | the final `report.json` written, attempt still `finalizing` | the same | the same |
| `record-review.committed` | the attempt complete and the run moved on (validated, back to implementing, or escalated), before output | the host saw no result | `next` follows the run state; `record-review` again is a no-op |
| `continue.committed` | the run back in `implementing`, before output | the host saw no result | `next` is `implement`, with `fix`; `continue` again changes nothing |
| `pr.created` | `gh pr create` succeeded, number not recorded | an open PR, run `validated` without `pr_number` | `pr` again → `recovered` |
| `pr.recorded` | the number recorded, before output | run `pr_open` | `pr` again → `updated` |

Child processes inherit the variable, so a project's tests should clear it; Escapement's `scripts/run-tests.sh` does.

## Exit status

| Status | Meaning |
|---|---|
| 0 | ok |
| 1 | error (usage, unknown run, illegal transition, …) |
| 2 | blocked (a precondition stopped it; see the codes above) |
| `exec` | the command's own exit status, or 124 when the runner killed it |
| `validate` | 0 whenever it recorded an attempt, whatever the outcome; read `outcome` from the JSON |
| `record-review` | 0 when it recorded the verdict, or already had, whatever the outcome; 2 when the verdict is rejected |
| `authorization` | 0 whether or not it matched; read `matched` |

`exec`'s statuses can overlap with 1 and 2 when the command itself exits with them, so hosts should read the JSON. With `--json`, the command's output goes only to the log, never to stdout.
