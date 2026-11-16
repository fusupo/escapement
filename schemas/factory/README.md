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
- **Verdict:** completeness against the attempt. The bundle's `required` lists what is needed. Every contract evidence ID is judged exactly once, with `supports_criterion` for test and command evidence and `procedure_adequate` for manual evidence. Every sensitive path and execution-policy change in the diff is signed off, every modified assertion is justified, nothing else is listed, and `source_digest` matches the snapshot issued for the attempt.

## Contracts name no commands

A contract says what must be demonstrated, never how the project's checks run.
`setup`, `static`, `verify` and `required-checks` come only from the project's
`## Escapement Settings`, so a contract can't skip or narrow a required check.
A narrowed `verify` for quick feedback between fix attempts is planned with the
fix loop (`docs/FACTORY_DESIGN.md` §6.2).
