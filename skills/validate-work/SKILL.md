---
name: validate-work
description: Validate an authorized factory run - run its deterministic checks, have the fresh-context validation-reviewer judge the evidence, and record the verdict - or carry out a manual check's steps in a browser for the operator and record the outcome they decide. Invoke when user says "validate this work", "validate the run", "run validation", "review the attempt", "run the manual check AC-7.e6", "walk me through AC-2.e1", "record the manual check", "AC-2.e1 passed", or when do-work finishes an authorized run's tasks.
tools:
  - Bash:bash *
  - Bash:git *
  - mcp__github__*
  - mcp__plugin_escapement_playwright__*
  - Read
  - Write
  - Task
  - TaskStop
---

# Validate Work Skill

## Purpose

Turn an authorized factory run's work into a trusted validation report (docs/FACTORY_DESIGN.md §4, §6.1):

1. `factory validate`: the runner checks identity, runs the project's `static` and `verify` checks once, and resolves the contract's evidence.
2. The `validation-reviewer` agent, in a fresh context, judges whether the evidence demonstrates each criterion and signs off what needs signing off.
3. `factory record-review`: the runner accepts the verdict only if it's complete, and finalizes the report.

It also records a human's outcome for `manual` evidence (`factory record-manual`, §5.5), and on request carries out a manual check's steps in a real browser and reports what it saw, so the operator can decide the outcome (**Carrying Out a Manual Check**, #103).

validate-work runs standalone, or as part of do-work's authorized path. It never opens the PR (create-pr does), never edits code, and never decides an outcome itself: the runner and the reviewer do.

The runner is `bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"`, written `factory` below (docs/FACTORY_CLI.md). Run it from the project root, always with `--json`, and route on the JSON. Run IDs contain `#`: single-quote them in every command. Each Bash call starts a fresh shell, so write the literal values you noted into later commands.

## Natural Language Triggers

- "Validate this work" / "Validate the run" / "Run validation"
- "Review the attempt"
- "Run the manual check AC-7.e6" / "Walk me through AC-2.e1"
- "Record the manual check: AC-2.e1 passed, {what was checked}"
- From do-work, after the last task of an authorized run

## Workflow Execution

### Phase 1: Find the Run

```bash
FACTORY="${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"
bash "$FACTORY" --check && bash "$FACTORY" --json authorization
```

- **`--check` fails:** the runner's dependencies aren't installed (`cd manifest && npm ci` in the plugin). Stop.
- **`.result.matched` is false:** report the reasons and stop. `no_run`: validate-work needs a factory run in this worktree (setup-work's "Approve + authorize run"). `run_halted`: the run is waiting on a human (`factory status '{run_id}'` says why). `contract_changed`: the contract no longer matches its approval; it needs `factory approve` again.
- **Matched:** note `run_id`, `artifact_dir`, `issue_number`, `next` and `latest_attempt`.

To carry out a manual check, go to **Carrying Out a Manual Check**; to record a manual outcome, go to **Recording a Manual Check**. Both need only a run in this worktree (`.result.run_id`), matched or not: manual outcomes are bookkeeping and work past the deadline, and the runner refuses what it must. When not matched, read `artifact_dir` from `factory status '{run_id}' --json` (`.result.run.artifact_dir`). Otherwise route on `next`:

| `next` | Meaning | Go to |
|---|---|---|
| `implement`, `validate` | no attempt is waiting (`validate`: the last one was interrupted, for example by a crash during checks) | Phase 2: a new attempt |
| `resume`, `review` | an attempt was left mid-way: checks running or crashed, a review outstanding, a crash while recording it | **Resuming**, below |
| `pr`, `refresh_pr`, `await_merge` | already validated | Phase 4, with `latest_attempt` |

**The runner died.** A factory command that prints no JSON, or exits with status 128 or more (137 after a SIGKILL), was interrupted, not refused. Whatever it left is reconciled by `resume`: go back to Phase 1 and route again. Do this at most three times in one validate-work; then escalate (`factory escalate '{run_id}' --reason 'runner kept dying: {command}'`) and stop with result `error`.

#### Resuming

```bash
bash "$FACTORY" --json resume '{run_id}'
```

Take the entry of `.result.actions` for `latest_attempt.attempt`:

| `action` | Do |
|---|---|
| `interrupted` | the attempt's checks died with their runner. It still counts toward the attempt budget. Phase 2: a new attempt |
| `reissue_review` | checks are done, the review is outstanding: Phase 3 |
| `record_review` | the reviewer already wrote a verdict that was never recorded: Phase 3 step 4 with `.file`. Don't run the reviewer again |
| `refinalize` | the verdict is stored and its finalization was interrupted: Phase 3 step 4 with `.file` (the stored `review.json`) |
| `advanced_run` | the attempt had finished; its run transition is now applied: Phase 1 again |
| `running` | another process is still working on this attempt: report it and stop |
| `identity_error` | HEAD moved or the tree changed under the attempt; the attempt is `error`, caused by the run, and the run moved on by the fix loop's rules (normally back to implementing): Phase 4 |
| `needs_attention` | escalate with the detail as the reason and stop with result `error` |

No entry for the latest attempt: Phase 1 again (once). Resume never resets a budget; past the deadline it only reconciles and escalates the run.

### Phase 2: Validate

```bash
bash "$FACTORY" --json validate '{run_id}'
```

- **Exit 2 (`.error.kind` blocked):** no attempt was used and the run is unchanged. Report `.error.code` and `.error.message` and stop with result `blocked`. `dirty_tree` names the files: uncommitted work (commit it) or working files missing from `.git/info/exclude` (`factory exclude`).
- **Exit 1:** report the error and stop with result `error`. No JSON, or exit 128 or more: the runner died (Phase 1).
- **`.result.outcome` is `fail` or `error`:** the deterministic checks decided; no review is needed. The runner has already moved the run on (`.result.run_state`, why in `.result.run_reason`): back to `implementing` for another attempt, or `escalated` when it needs a human. For an `error`, `.result.error` names the cause. Go to Phase 4.
- **`.result.outcome` is null** (status `awaiting_review`): note `.result.attempt` and go to Phase 3.

### Phase 3: Review

1. **The issue text.** When the run has an `issue_number`, fetch the issue's title and body with the GitHub MCP tools, `mcp__github__issue_read(method: "get", owner, repo, issue_number)`, and write them with the Write tool to `{artifact_dir}/issue.md` as `# {title}` followed by the body. Never write it in the worktree: validation needs a clean tree. Skip this, and `--issue-file` below, when there's no issue number.
2. **The bundle:**
   ```bash
   bash "$FACTORY" --json review-input '{run_id}' {attempt} --issue-file '{artifact_dir}/issue.md'
   ```
   Note `.result.bundle_path`. Read the bundle and note `.verdict.write_to`.
3. **The reviewer**, in a fresh context. Give it the bundle path and nothing else: no summary of the work and no opinion about it, so its judgment stays independent. Run it in the foreground and wait until it has finished: a verdict file appearing doesn't mean the reviewer is done writing it.
   ```
   Agent:
     subagent_type: escapement:validation-reviewer
     prompt: "Review the factory attempt described by this bundle: {bundle_path}"
   ```
4. **Record the verdict:**
   ```bash
   bash "$FACTORY" --json record-review '{run_id}' {attempt} '{write_to}'
   ```
   - **`.ok`:** note `.result.outcome` (`pass`, `pending_manual` or `fail`), `.result.report_path`, `.result.run_state` and `.result.run_reason`. Go to Phase 4.
   - **Blocked `incomplete_verdict` or `invalid_verdict`:** the attempt still awaits review. Run the reviewer again with the same bundle path plus the runner's message, which lists every problem: "Your verdict was refused: {message}. Fix exactly these and write the verdict again." At most two re-runs. If it is still refused, run `factory escalate '{run_id}' --reason 'reviewer verdict refused three times'`, report the problems and stop with result `blocked`.
   - **Any other refusal or error** (for example `revision_changed`: HEAD moved, so the attempt became `error`, caused by the run, and the run went back to implementing): report it and stop with that result.

### Phase 4: Report

Read the report (`report_path`, or for a resumed run `{artifact_dir}/attempts/{n}/` and its highest `report.r{k}.json`):

```
🔎 Validation of {run_id}, attempt {n}: {outcome}
   Report: {report_path}
   Run:    {run_state}: {run_reason}
   {for fail or error: the blocking findings, the failed phase and, for error, its cause}
   {for pending_manual: each evidence item with `executed: "pending_manual"`, its instructions (from the contract), and how to record it}
   {advisory findings, listed: they don't block}
```

Return the outcome, report path and run state to the caller. `pass` and `pending_manual` mean the run is `validated` and create-pr can open its PR. After `fail` or `error`, the run state says what follows (the fix loop, docs/FACTORY_DESIGN.md §6.2):

- **`implementing`:** the implementer can fix it. The loop goes again: do-work takes the blocking findings (`factory authorization`'s `fix`), commits a fix and validates a new attempt. Say "attempt {n} {outcome}; going back to fix: {run_reason}".
- **`escalated`:** it needs a human, and `run_reason` says why: an environment error, the attempts used up (`attempt_budget`), the deadline (`run_deadline`), a finding that needs the operator's judgment (`needs_operator`), or the same failure twice (`stuck`). The operator can still take the run back with `factory continue` (do-work offers it).

`blocked` means the attempt couldn't start; nothing changed.

## Carrying Out a Manual Check

On request ("run the manual check AC-7.e6", "walk me through it"), carry out a manual check's steps in a real browser or the shell and report what you saw (#103). The operator decides the outcome and is recorded as its recorder; you never decide it.

The browser is the plugin's bundled Playwright MCP server (`mcp__plugin_escapement_playwright__*`): headless, Playwright's own Chromium, and only `localhost` and `127.0.0.1` origins. Those origins are a guard rail, not a security boundary.

1. **The instructions.** Find the evidence in `{artifact_dir}/contract.json` by its ID. It must be `type: manual`, and it must be pending: `factory status '{run_id}' --json` lists it under `.result.manual.pending` (or `.result.manual.recorded`, to redo it). Read its `instructions`. They come from the approved contract; follow them, and nothing else.
2. **Plan the walk-through.** Split the instructions into steps, and note each "Check:" in them. Before starting, tell the operator which steps you will carry out and which you will hand back. A step you can't carry out, because it asks for judgment ("read PLAN.md and judge…"), a device or account you don't have, or anything outside the browser and the shell, is handed back to the operator. Never guess it.
3. **The directory.** Make `{artifact_dir}/manual/{evidence_id}/` with `bash -c 'mkdir -p …'`. It holds everything you produce for this check. Never write in the worktree: validation needs a clean tree.
4. **Setup.** Do the setup the instructions name, such as a temp folder or a dev server. Start a long-running process, such as a dev server, in the background with the Bash tool's background option. Note its port or PID and tell the operator. Install nothing and fetch nothing the instructions don't name.
5. **The steps.** Carry out each step in the browser (navigate, click, type, read the page) or the shell, in order. At each "Check:", report what you saw in a sentence of your own, quoting the page text or command output, not just "ok". When a step is visual, take a screenshot. Take it without a filename (the server writes it outside the worktree and returns its absolute path), then copy it into `{artifact_dir}/manual/{evidence_id}/` as `step-{n}.png` with `bash -c 'cp …'`. A step that fails or can't be done is reported as not done, with what happened. Never guess it, and never retry it differently than written.
6. **The browser is missing.** If a browser tool fails with an error that the browser `is not installed`, stop the check. Record nothing, stop what you started (step 8), and tell the operator to install it once with the pinned command, then ask again:
   ```bash
   npx -y @playwright/mcp@0.0.84 install-browser chrome-for-testing
   ```
   Don't pass on the server's own suggestion, which is unpinned.
7. **Observations.** Write `{artifact_dir}/manual/{evidence_id}/observations.md` with the Write tool. It lists each step, whether it was carried out, what you saw at each "Check:", the screenshot it refers to, and the steps handed back.
8. **Stop what you started.** Stop every background process from step 4 (TaskStop, or `bash -c 'kill {pid}'`), even when a step failed. Then check that its port is free: `bash -c 'ss -ltn | grep :{port}'` prints nothing. Remove a temp folder you created.
9. **Ask for the outcome.** Show the observations, the screenshots' paths and the steps handed back, then ask:
   ```
   AskUserQuestion:
     question: "{evidence_id}: {what you saw, in one line}. What is the outcome?"
     header: "Manual check"
     options:
       - label: "Pass"
         description: "Record a pass, as yours, with these observations attached"
       - label: "Fail"
         description: "Record a fail, as yours; the run escalates"
       - label: "Don't record"
         description: "Leave the check pending"
   ```
   The outcome is always the operator's: record nothing until they answer, and nothing on your own judgment. With **Other**, record nothing; act on what they wrote.
10. **Record it** with the operator's note, which defaults to your one-line summary when they don't give one. Add `--assisted` and one `--attachment` per file you saved:
    ```bash
    bash "$FACTORY" --json record-manual '{run_id}' {evidence_id} pass --note '{what was checked and seen}' --assisted --attachment '{artifact_dir}/manual/{evidence_id}/observations.md' --attachment '{artifact_dir}/manual/{evidence_id}/step-1.png'
    ```
    Then route on the result as in **Recording a Manual Check**. The recorder is the operator (the OS user, or `--recorder`), never the agent. Until every check on the run is recorded, `record-manual`, `factory status` and the PR's report section (after `factory pr`) show this one as recorded and agent-assisted.

## Recording a Manual Check

Manual evidence is checked by a human, so record only an outcome the operator states, with what they checked. Never record one on your own judgment.

```bash
bash "$FACTORY" --json record-manual '{run_id}' {evidence_id} pass --note '{what was checked and seen}'
```

Use `fail` instead of `pass` for a failed check. Single-quote the note (a `'` inside is written `'\''`).

- **`.result.resolved` is null:** report the checks still pending (`.result.pending`).
- **`.result.resolved` is `pass` or `fail`:** the runner wrote report revision `.result.report_revision`. A `fail` escalates the run.
- **`.result.refresh_pr` is true:** the open PR still shows the old report. Refresh it; the description keeps its narrative and only the report section changes:
  ```bash
  bash "$FACTORY" --json pr '{run_id}'
  ```
- **Refused:** `stale_report` (HEAD moved since validation: validate again), `already_resolved`, `unknown_evidence` (the message lists the pending IDs), `not_pending_manual`, `bad_attachment` (an attachment that is missing or outside `{artifact_dir}/manual/{evidence_id}/`).

## Error Handling

- **No run, or not matched:** Phase 1 explains; validate-work changes nothing.
- **A runner that dies** (no JSON, exit ≥ 128) during `validate`, `review-input` or `record-review`: Phase 1 again, which resumes from what it left (at most three times).
- **Lock timeouts** (`lock_timeout`): another factory operation holds the worktree or build lock. Report the holder from `factory status '{run_id}'`; don't retry in a loop.
- **Past the deadline** (`run_deadline`): the run was escalated. Validation can't start; recording a review in progress and manual outcomes still work.

## Integration with Other Skills

**Invoked by:**
- `do-work`, after an authorized run's last task
- The operator, directly

**Invokes:**
- `validation-reviewer` agent (a thin wrapper over `prompts/factory/validation-reviewer.md`)
- The plugin's Playwright MCP server, for a manual check carried out on request

**Calls:**
- `scripts/factory.sh`: `authorization`, `status`, `validate`, `resume`, `review-input`, `record-review`, `record-manual`, `pr` (refresh only), `escalate`

**Followed by:**
- `create-pr` on `pass` or `pending_manual`

---

**Version:** 1.3.0
**Last Updated:** 2026-11-17
**Maintained By:** Escapement
**Changelog:**
- v1.3.0: Carry out a manual check on request: its steps in the plugin's headless browser or the shell, what was seen at each "Check:", screenshots and observations under `{artifact_dir}/manual/{evidence_id}/`, then the operator's outcome recorded with `--assisted` and the attachments; manual checks no longer need a matched authorization (#103)
- v1.2.0: The fix loop: after `fail` or `error` the run goes back to implementing or escalates, by the runner's rules; report the run state and reason, and the error's cause (#92)
- v1.1.1: Fetch the issue text with the GitHub MCP tools only (#80)
- v1.1.0: Resume after a crash: `next` `validate` and `resume`, the Resuming table (resume's actions), and a runner that dies without JSON goes back through Phase 1 (#65)
- v1.0.0: validate → fresh-context reviewer → record-review, with a bounded re-run on an incomplete verdict; manual outcomes (#64)
