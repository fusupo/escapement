---
name: validate-work
description: Validate an authorized factory run - run its deterministic checks, have the fresh-context validation-reviewer judge the evidence, and record the verdict - or record a human's outcome for a manual check. Invoke when user says "validate this work", "validate the run", "run validation", "review the attempt", "record the manual check", "AC-2.e1 passed", or when do-work finishes an authorized run's tasks.
tools:
  - Bash:bash *
  - Bash:git *
  - mcp__github__*
  - Read
  - Write
  - Task
---

# Validate Work Skill

## Purpose

Turn an authorized factory run's work into a trusted validation report (docs/FACTORY_DESIGN.md §4, §6.1):

1. `factory validate`: the runner checks identity, runs the project's `static` and `verify` checks once, and resolves the contract's evidence.
2. The `validation-reviewer` agent, in a fresh context, judges whether the evidence demonstrates each criterion and signs off what needs signing off.
3. `factory record-review`: the runner accepts the verdict only if it's complete, and finalizes the report.

It also records a human's outcome for `manual` evidence (`factory record-manual`, §5.5).

validate-work runs standalone, or as part of do-work's authorized path. It never opens the PR (create-pr does), never edits code, and never decides an outcome itself: the runner and the reviewer do.

The runner is `bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"`, written `factory` below (docs/FACTORY_CLI.md). Run it from the project root, always with `--json`, and route on the JSON. Run IDs contain `#`: single-quote them in every command. Each Bash call starts a fresh shell, so write the literal values you noted into later commands.

## Natural Language Triggers

- "Validate this work" / "Validate the run" / "Run validation"
- "Review the attempt"
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

To record a manual outcome, go to **Recording a Manual Check**. Otherwise route on `next`:

| `next` | Meaning | Go to |
|---|---|---|
| `implement` | no attempt is waiting | Phase 2 |
| `resume` | an attempt's checks were interrupted | run `factory resume '{run_id}'`, then Phase 1 again (once) |
| `review` | `latest_attempt` awaits review | Phase 3, with `latest_attempt.attempt` |
| `pr`, `refresh_pr`, `await_merge` | already validated | Phase 4, with `latest_attempt` |

### Phase 2: Validate

```bash
bash "$FACTORY" --json validate '{run_id}'
```

- **Exit 2 (`.error.kind` blocked):** no attempt was used and the run is unchanged. Report `.error.code` and `.error.message` and stop with result `blocked`. `dirty_tree` names the files: uncommitted work (commit it) or working files missing from `.git/info/exclude` (`factory exclude`).
- **Exit 1:** report the error and stop with result `error`.
- **`.result.outcome` is `fail` or `error`:** the deterministic checks decided; no review is needed, and the run is escalated. Go to Phase 4.
- **`.result.outcome` is null** (status `awaiting_review`): note `.result.attempt` and go to Phase 3.

### Phase 3: Review

1. **The issue text.** When the run has an `issue_number`, fetch the issue's title and body with the GitHub tools, or `gh issue view {number} --json title,body`, and write them with the Write tool to `{artifact_dir}/issue.md` as `# {title}` followed by the body. Never write it in the worktree: validation needs a clean tree. Skip this, and `--issue-file` below, when there's no issue number.
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
   - **`.ok`:** note `.result.outcome` (`pass`, `pending_manual` or `fail`), `.result.report_path` and `.result.run_state`. Go to Phase 4.
   - **Blocked `incomplete_verdict` or `invalid_verdict`:** the attempt still awaits review. Run the reviewer again with the same bundle path plus the runner's message, which lists every problem: "Your verdict was refused: {message}. Fix exactly these and write the verdict again." At most two re-runs. If it is still refused, run `factory escalate '{run_id}' --reason 'reviewer verdict refused three times'`, report the problems and stop with result `blocked`.
   - **Any other refusal or error** (for example `revision_changed`: HEAD moved, so the attempt became `error` and the run escalated): report it and stop with that result.

### Phase 4: Report

Read the report (`report_path`, or for a resumed run `{artifact_dir}/attempts/{n}/` and its highest `report.r{k}.json`):

```
🔎 Validation of {run_id}, attempt {n}: {outcome}
   Report: {report_path}
   Run:    {run_state}
   {for fail or error: the blocking findings and the failed phase}
   {for pending_manual: each evidence item with `executed: "pending_manual"`, its instructions (from the contract), and how to record it}
   {advisory findings, listed: they don't block}
```

Return the outcome and report path to the caller. `pass` and `pending_manual` mean the run is `validated` and create-pr can open its PR. `fail`, `error` and `blocked` mean the run waits on a human. The fix loop, where the implementer retries on findings, comes in a later release.

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
- **Refused:** `stale_report` (HEAD moved since validation: validate again), `already_resolved`, `unknown_evidence` (the message lists the pending IDs), `not_pending_manual`.

## Error Handling

- **No run, or not matched:** Phase 1 explains; validate-work changes nothing.
- **Lock timeouts** (`lock_timeout`): another factory operation holds the worktree or build lock. Report the holder from `factory status '{run_id}'`; don't retry in a loop.
- **Past the deadline** (`run_deadline`): the run was escalated. Validation can't start; recording a review in progress and manual outcomes still work.

## Integration with Other Skills

**Invoked by:**
- `do-work`, after an authorized run's last task
- The operator, directly

**Invokes:**
- `validation-reviewer` agent (a thin wrapper over `prompts/factory/validation-reviewer.md`)

**Calls:**
- `scripts/factory.sh`: `authorization`, `validate`, `resume`, `review-input`, `record-review`, `record-manual`, `pr` (refresh only), `escalate`

**Followed by:**
- `create-pr` on `pass` or `pending_manual`

---

**Version:** 1.0.0
**Last Updated:** 2026-11-16
**Maintained By:** Escapement
**Changelog:**
- v1.0.0: validate → fresh-context reviewer → record-review, with a bounded re-run on an incomplete verdict; manual outcomes (#64)
