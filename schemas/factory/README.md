# Factory schemas

JSON Schema (draft 2020-12) for the documents the Escapement factory runner
reads and writes. They are published so that hosts other than the Escapement
skills, such as Escapement Studio, can produce and check these documents
without depending on the runner's code. The runner validates against these
same files, so they can't drift from what it enforces.

| Schema | Written by | Read by | Design |
|---|---|---|---|
| `contract.schema.json` | the planner (setup-work, or any host) | `factory approve`, `factory check` | §5.1, §5.2 |
| `readiness.schema.json` | `factory check`, plus the planner's own questions | the operator, the host | §3.1 |
| `report.schema.json` | the runner (`attempts/{n}/report.json`) | `create-pr`, the gate, hosts | §5.3, §5.4 |
| `verdict.schema.json` | the reviewer (`prompts/factory/validation-reviewer.md`) | `factory record-review` | §4.9 |
| `critique.schema.json` | the plan critic (`prompts/factory/plan-critic.md`), then the host adds `dispositions` | `factory check-critique`, `factory record-critique` | §3.5, §7.2 |

Section numbers refer to `docs/FACTORY_DESIGN.md`.

Each document carries `"version": 1`. A change that would reject documents
valid today gets a new version.

## Finding the files

Hosts shouldn't hard-code the plugin layout. Ask the runner:

```bash
bash "$PLUGIN_ROOT/scripts/factory.sh" schema contract          # prints the path
bash "$PLUGIN_ROOT/scripts/factory.sh" schema contract --print  # prints the schema
```

## The reviewer prompt

The verdict's author is defined as data too. `prompts/factory/validation-reviewer.md`
tells any runtime how to read the bundle that `factory review-input` writes and how
to write a verdict this schema and `record-review` accept. Find it the same way:

```bash
bash "$PLUGIN_ROOT/scripts/factory.sh" prompt reviewer          # prints the path
bash "$PLUGIN_ROOT/scripts/factory.sh" prompt reviewer --print  # prints the prompt
```

The bundle also names it (`reviewer_prompt`), along with this schema
(`verdict.schema`). The Claude Code agent `agents/validation-reviewer.md` is a
thin wrapper over the same prompt.

## What the schemas don't check

Some rules depend on more than one document, and only the runner checks them:

- **Contract:** criterion and evidence IDs are unique, `stdout_matches` and `stdout_not_matches` compile as JavaScript regular expressions, and `run_id` equals the run being approved.
- **Report:** `invocations` lists every command the attempt ran, with paths relative to the attempt directory. Each results file carries its digest, binding the evidence to the invocation that produced it (§4.4). Advisory findings with IDs `assertion:{file:line}` and `policy:{path}` are the modified assertions and execution-policy changes the reviewer must address (§4.6).
- **Report:** once a verdict is recorded, `report.json` is the final report: `status` `complete`, the reviewer's judgments and `rationale` on each evidence item, and a `review` block with the verdict and source digests, sign-offs and justifications. The draft is kept as `report.draft.json`.
- **Report errors:** an attempt whose `outcome` is `error` carries `error: {cause, reason}`. The runner sets the cause from where the error happened, never from the reason text: `code` and `run` errors go back to the implementer in the fix loop, and an `environment` error waits on the operator (§5.4, §6.2). The cause is also stored on the attempt, for error attempts that complete before a final report exists.
- **Report revisions:** when a human resolves `pending_manual` with `factory record-manual`, the runner writes `attempts/{n}/report.r{k}.json` (k ≥ 2) with `revision`, `supersedes`, the new `outcome` and `manual_outcomes`. Earlier revisions, `report.json` included, are never changed; the highest revision is the attempt's current report. Each human outcome is bound to the report's `head_sha` and `contract_digest` (§5.5). An outcome may carry `assisted: true` and `attachments` (paths relative to the artifact dir, under `manual/{evidence_id}/`) when the agent carried out the check's steps and the human decided from its observations (#103); both are optional, so older reports stay valid at version 1.
- **Report findings:** a reviewer `judgment:{id}` finding carries `evidence_type`, the judged item's contract type. The fix loop escalates a rejected manual procedure (`evidence_type: manual`) at once, since only a re-approved contract can change its instructions, and loops on test or command evidence. Findings recorded before #99 have no `evidence_type` and loop (§6.2).
- **Critique:** every checklist item is judged exactly once, finding IDs are unique, a `concern` has a finding naming its checklist item, `approve` carries no `blocking` finding, `revise` and `escalate` have at least one finding, and each disposition names a finding, at most once. The final record (`check-critique --final`, and always `record-critique`) has a disposition for every finding.
- **Verdict:** completeness against the attempt. The bundle's `required` lists what is needed. Every contract evidence ID is judged exactly once, with `supports_criterion` for test and command evidence and `procedure_adequate` for manual evidence. Every sensitive path and execution-policy change in the diff is signed off, every modified assertion is justified, nothing else is listed, and `source_digest` matches the snapshot issued for the attempt.

## Contracts name no commands

A contract says what must be demonstrated, never how the project's checks run.
`setup`, `static`, `verify` and `required-checks` come only from the project's
`## Escapement Settings`, so a contract can't skip or narrow a required check.
A narrowed `verify` for quick feedback between fix attempts is planned with the
fix loop (`docs/FACTORY_DESIGN.md` §6.2).
