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
| `verdict.schema.json` | the reviewer | `factory record-review` | §4.9 |

Section numbers refer to `docs/FACTORY_DESIGN.md`.

Each document carries `"version": 1`. A change that would reject documents
valid today gets a new version.

## Finding the files

Hosts shouldn't hard-code the plugin layout. Ask the runner:

```bash
bash "$PLUGIN_ROOT/scripts/factory.sh" schema contract          # prints the path
bash "$PLUGIN_ROOT/scripts/factory.sh" schema contract --print  # prints the schema
```

## What the schemas don't check

Some rules depend on more than one document, and only the runner checks them:

- **Contract:** criterion and evidence IDs are unique, `stdout_matches` and `stdout_not_matches` compile as JavaScript regular expressions, and `run_id` equals the run being approved.
- **Verdict:** completeness against the attempt. Every contract evidence ID is judged exactly once, every sensitive path in the diff is signed off, every modified assertion is justified, and `source_digest` matches the snapshot issued for the attempt.

## Contracts name no commands

A contract says what must be demonstrated, never how the project's checks run.
`setup`, `static`, `verify` and `required-checks` come only from the project's
`## Escapement Settings`, so a contract can't skip or narrow a required check.
A narrowed `verify` for quick feedback between fix attempts is planned with the
fix loop (`docs/FACTORY_DESIGN.md` §6.2).
