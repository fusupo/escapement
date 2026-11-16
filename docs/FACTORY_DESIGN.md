# Factory Design: Contract-Driven Validation Loops

> Evolving Escapement from an operator-driven workflow into a progressively autonomous software factory.
>
> Captured: 2026-11-15
> Revised: 2026-11-15 (r3.2, after three independent design reviews and a follow-up — see §13)
> Status: Design settled for first release; build in progress (status in §10, updated 2026-11-16)
> Builds on: `docs/MANIFEST_SYSTEM_DESIGN_V2.md`, existing skills (`setup-work`, `do-work`, `commit-changes`, `create-pr`, `review-pr`, `archive-work`)

---

## 0. Note to Reviewers

r3 is intended as the last design revision before building the first release. Further rigor should come from a real run through the vertical slice, not more design rounds. Review feedback is most useful if it identifies something that would make the first release **unbuildable, unsafe, or misleading** — not refinements that belong to later tiers.

Background reasoning is in §1. §13 records what each review changed and why.

---

## 1. Background and Reasoning

### 1.1 Where Escapement is today

Escapement is a Claude Code plugin implementing a sequential workflow:

```
setup-work → do-work ⇄ commit-changes → create-pr → review-pr → archive-work
```

plus a manifest subsystem (SQLite dependency graph over GitHub issues, with a TypeScript CLI) that computes a dispatchable frontier, predicts file overlap, and dispatches parallel agents into worktrees. A `PROJECT_LORE.md` retro in `archive-work` captures non-obvious lessons.

What already works well: structured planning (scratchpads), atomic commits, durable archives, dependency-aware dispatch.

### 1.2 What's missing

The operator is the validation system:

- **"Done" is subjective.** `do-work` finishes when scratchpad checkboxes are ticked.
- **Standards are invented after the fact.** Review judges code against whatever "done" means to the reviewer at that moment.
- **Review is not independent.** `review-pr` shares context — and blind spots — with the implementer.
- **Plans are approved, not challenged.**
- **Every step is interactive.** `do-work`, `commit-changes`, and `create-pr` each stop for confirmations, so nothing progresses while the operator is away.

### 1.3 The core idea

**Planning produces a contract; validation checks the code against it.**

If `setup-work` defines what "done" means — each acceptance criterion paired with the evidence that will demonstrate it — validation becomes constrained and auditable rather than open-ended. Judgment doesn't disappear (someone still decides that a passing test actually demonstrates a criterion), but it is narrowed to explicit, recorded claims.

**What this does not establish:** a contract makes validation *auditable*; it does not prove the specification or the tests are *adequate*. Fresh context reduces anchoring, but the planner, critic, and reviewer can still share the same mistaken reading of an issue. The operator's plan approval is the check on the contract itself, and escaped defects (§7.2) are the only signal that it was wrong.

```
PLAN:     planner ⇄ critic          → approved plan + validation contract
BUILD:    implementer ⇄ validator   → a validated revision
RELEASE:  gate                      → auto-merge | ping human
```

### 1.4 Guiding principles

1. **Earn autonomy with data.** Gates start strict and loosen only on pre-declared evidence (§7.4).
2. **A report is about one revision.** Results are bound to the exact code, contract, target, and policy they checked.
3. **Guarantees live in code, judgment lives in agents.** Locking, deadlines, process cleanup, and report writing are done by a deterministic runner (§4). Skills orchestrate; agents judge.
4. **Separation of authorship.** Fresh-context agents review plans and code. Location-based hiding is a weak boundary and is described as such.
5. **Bounded by count and by time — and honest about which bounds are enforced.** The runner enforces command deadlines and refuses new work past the run deadline; agent wall-clock and token limits are advisory until something can enforce them.
6. **Agents judge; code checks the judgment is complete.** The runner rejects agent output that omits required judgments.
7. **Respect machine limits.** Builds and tests are serialized machine-wide (the operator's machine freezes under parallel Node/test load).
8. **Capture metrics from day one,** with enough identity to attribute outcomes later.

---

## 2. Scope: Where We Draw the Line

### 2.1 First release: a complete vertical slice

Single issue, operator-initiated, operator holds the merge. The slice must run end to end:

```
setup-work (contract) → approve → implement → commit → validate → PR with report
                                                          └─ fail: persist, stop, notify
```

| Item | Purpose |
|---|---|
| Validation contract + evidence types | Coupling point between planning and validation |
| Readiness check + two risk tiers | Whether a contract is possible; whether the gate may ever recommend auto-merge |
| Factory runner (`factory` CLI) | Owns execution, lock, deadlines, cleanup, parsing, reports, run state |
| Run artifacts in the context dir | Keeps the tree clean and the report's subject unambiguous |
| One fresh-context reviewer | Criterion support + broader correctness, from captured evidence |
| Authorized run path through `do-work`, `commit-changes`, `create-pr` | Two operator touches: plan approval and merge |
| Run state machine + recovery basics | Interrupted runs resume without repeating or corrupting work |
| Metrics tables | Start the trust record |

Success: on a real project, an issue goes from `setup-work` to a PR whose validation report the operator trusts, touching only plan approval and merge — **and an interrupted run resumes correctly.**

#### The slice, step by step

One run through the first release. This table only gathers what §3.6, §4.1, §4.7 and §6.1 specify; those sections are authoritative.

| # | Step | Actor | Command | Run state after | Attempt state | Writes / records | Checks and guarantees |
|---|---|---|---|---|---|---|---|
| 1 | Readiness | agent (`setup-work`) | — | (no run) | — | `ready` \| `needs_human` + questions (§3.1) | a criterion that can't be given evidence → `needs_human` |
| 2 | Plan + contract | agent (`setup-work`), runner | `factory start <issue>` | `planned` | — | run row, artifact dir, `contract.json`, proposed tier, `.git/info/exclude` entries | — |
| 3 | Approve (**operator touch 1**) | operator, runner | `factory approve <run_id>` | `approved` | — | contract digest, test/policy baseline at `merge_base_sha`, `deadline_at`, authorization `active` (§3.6) | any later contract change revokes the authorization |
| 4 | Implement | agent (`do-work`) | `factory exec <run_id> -- <cmd>` | `implementing` | — | command logs | build lock, command deadline, process-group kill; confirmations skipped only under a matching authorization |
| 5 | Commit | agent (`commit-changes`) | — | `implementing` | — | commits | authorization matches repo, branch and contract digest |
| 6 | Validate | runner (via `do-work` / `validate-work`) | `factory validate <run_id>` | `validating` | `checks_running → awaiting_review` (or `complete` on a deterministic failure) | draft report, logs, structured results | worktree lock, clean tree, contract digest, deadline; `HEAD` captured and re-checked (§4.3) |
| 7 | Review | agent (`validation-reviewer`), runner | `factory review-input`, `factory record-review` | `validated` | `finalizing → complete` | source snapshot, `review.json`, final report | completeness rules and source digest (§4.9) |
| 8 | PR | runner | `factory pr <run_id>` | `pr_open` | — | PR number; operator notified | idempotent lookup; branch head = report `head_sha` (§4.8) |
| 9 | Merge (**operator touch 2**) | operator | — | `closed` (merged) | — | operator action and merge SHA (recorded by `manifest-sync`, next) | merge is never authorized |

- Step 8 runs on `pass` or `pending_manual` (§6.1). Manual outcomes are recorded later with `factory record-manual` (§5.5).
- *As built (#64):* steps 4–8 run in `do-work` without questions when `factory authorization` matches. Commits (step 5) carry the AI agent's identity, and step 8's push and PR run as the agent's GitHub account (§4.8). `archive-work` closes the run after the merge.
- **Failure path:** `fail`, `blocked` or `error` at step 6 or 7 moves the run to `escalated`. The report is kept, the operator is notified, and the run stops. The fix loop (§6.2) is next.

### 2.2 Next (in order)

1. **Bounded fix loop** — on `fail`, implementer iterates on findings instead of stopping.
2. **Plan critique** — one round, measured from its first run.
3. **Gate in report-only mode** — compute and record a recommendation; always ping.

### 2.3 Later

- Merge-result validation and conditional merge (prerequisite for enforcing mode, §6.3).
- Gate in enforcing mode, per project and work type, after §7.4.
- Asynchronous escalation; hidden scenarios; test-first by a separate agent; reviewer specialization; a third risk tier if data shows a use for it.
- Outer loop (`tick`); parallel factory via `manifest-dispatch`; factory self-improvement.

### 2.4 Out of scope

- Fully lights-out operation at any tier in this document.
- A custom agent runtime, UI, or dashboard.
- Replacing `review-pr` for human-authored PRs.

### 2.5 Prerequisites

- **#57** — context-path detection matches the documentation example `../myproject-ctx` before the real value; run artifacts would land in the wrong place. *Resolved (PR #68).*
- **Project identity in the manifest code.** `manifest/init.ts` `resolveContextPath()` reads the `CLAUDE.md` next to the *plugin* (`resolve(__dirname, "..")`), so without an explicit data dir every consuming project resolves to Escapement's own context path and DB. The CLI must take the target repo/worktree root explicitly (flag or cwd's git toplevel) and resolve context-path from that project's `CLAUDE.md`. *Resolved (#58), differently: the manifest is one per-user database shared by all projects (`${XDG_DATA_HOME:-~/.local/share}/escapement/manifest.db`), because work items carry their repo and dependencies cross repos. The plugin's location no longer matters. The factory still needs the target root for its own run artifacts, which is `--project-root` in #59.*
- **Versioned schema.** `ensureSchema()` skips initialization whenever `work_items` exists, so factory tables would never be added to existing DBs. Replace with a `schema_version` table (or `PRAGMA user_version`) and ordered migrations. *Resolved (#58): `PRAGMA user_version` and `manifest/migrations.ts`. Factory tables arrive as migration 2.*

---

## 3. Stage 1: Augmented `setup-work`

```
issue
  → 1. readiness check          [first]
  → 2. context gathering        [first, light]
  → 3. risk tier (proposed)     [first]
  → 4. plan                     (existing)
  → 5. contract                 [first]
  → 6. critique loop            [next]
  → 7. operator approval        (existing; now approves plan + contract → run authorization)
```

### 3.1 Readiness check

Are acceptance criteria present or derivable? Unresolved questions about intent, scope, or dependencies? Output `ready` | `needs_human` with a minimal list of specific questions; mirror into manifest `meta.needs_human`/`meta.ambiguities` if applicable. A criterion that can't be given evidence is a readiness failure.

*As built (#63):* `setup-work` takes the factory path only when a settings-only `factory check` (no `--contract`) is `ready`, meaning every required check has a command; otherwise it is unchanged. It asks its judgment questions (intent, scope, dependencies, criteria without evidence) before planning, runs `factory check` on the drafted contract, and mirrors the final readiness with `manifest.sh readiness <owner/repo> <issue>`. The questions go in `meta.readiness_questions` rather than `meta.ambiguities`, which `manifest-bootstrap` uses for dependency questions, so a `ready` result never clears those. The manifest is read only if it already exists.

### 3.2 Context gathering

Relevant `PROJECT_LORE.md` entries, archives of related prior work (manifest `archive_path`), and similar implementations (scratchpad-planner already does the last).

### 3.3 Risk tiers (first release: two)

| Tier | Definition | Effect in first release |
|---|---|---|
| `standard` | everything not sensitive | gate may (later) recommend auto-merge if clean |
| `sensitive` | actual or predicted diff touches project `sensitive-paths`; changes execution policy (§4.6); migrations, auth, money, public API, architecture by planner/reviewer judgment | gate never recommends auto-merge; reviewer is instructed to apply heightened scrutiny and must explicitly sign off each sensitive path |

The tier is proposed at planning and recomputed from the actual diff during validation; the higher wins. Validation phases are the same for both tiers in the first release — the tier changes gate eligibility and review emphasis, nothing else.

Projects list `sensitive-paths` (§8). In repositories where markdown controls behavior, those paths are sensitive (Escapement: `skills/**`, `agents/**`, `hooks/**`, `CLAUDE.md`). Dependency and config changes are not categorically safe; projects list the ones that matter.

### 3.4 Contract

The planner produces the contract (§5) in the run's artifact directory (§4.2). For evidence demonstrating **new or corrected behavior**, the plan states the test should fail without the change; **regression** evidence is expected to already pass.

### 3.5 Critique loop (next)

A critic agent with fresh context gets the issue, scratchpad, contract, and read access to the codebase — not the planner's transcript.

Checklist: every criterion has capable evidence; new-behavior tests would plausibly fail without the change; predicted files plausible; materially simpler approach?; lore/convention conflicts; hidden coupling with other manifest items; tier right; issue too large.

Verdict `approve | revise | escalate` with severity-rated findings and optional tier raise. **One round**: `revise` returns to the planner once; anything unresolved goes to the operator with both positions. Each finding is recorded with whether it was accepted and what plan change it caused (§7.2), since a useful critique prevents failures that would otherwise never appear in validation.

### 3.6 Plan approval → run authorization

Approval creates a run (§4.7) and an authorization recorded in the manifest DB:

```json
{
  "run_id": "esc#42-r1",
  "repo": "fusupo/escapement",
  "branch": "42-refresh-expiry",
  "target_ref": "develop",
  "contract_digest": "sha256:…",
  "approved_at": "2026-11-15T14:02:00Z",
  "authorizes": ["commit", "push_branch", "open_pr", "run_validation"],
  "excludes": ["merge", "force_push", "contract_change", "push_other_branches"],
  "status": "active"
}
```

- Skills check for an `active` authorization matching repo, branch, and contract digest before skipping confirmations. Without one, existing interactive behavior is unchanged.
- **Ends** when the run reaches a terminal state (§4.7). **Revoked** by `factory revoke <run_id>` or by any contract change (re-approval issues a new authorization on the same run).

*As built (#63):* approval offers "Approve + authorize run" next to plain "Approve", which creates no run. The run is created only on that choice, so a rejected plan leaves nothing behind: the contract is drafted in the scratchpad with `run_id: "pending"`. On approval `setup-work` checks out the feature branch (`factory start` now refuses the target branch, `on_target_branch`), runs `factory exclude` for its working files, starts the run, writes the contract with the real `run_id` to `{artifact_dir}/contract.draft.json`, checks and approves it, and confirms that the authorization's digest equals that of the stored `contract.json`. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#start), `skills/setup-work/SKILL.md` Phase 4.5.

*As built (#64):* skills ask one question, `factory authorization`. It matches the worktree's run on repo, branch, active authorization, `contract.json` digest, a non-halted state and the deadline, and answers with what the authorization allows and an advisory next step (implement, validate, resume, review, pr, refresh_pr, await_merge). It is read-only and never creates the database. `commit-changes`, `create-pr` and `do-work` drop their confirmations only on a match with the action they take. Under an authorization, the factory's work is visible as the AI agent's: commits carry its name and email (`factory agent`), and the push and PR run as its GitHub account. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#authorization).

---

## 4. Stage 2: The Factory Runner and `validate-work`

### 4.1 The runner

Instructions cannot guarantee locking, deadlines, or cleanup; code can. A small deterministic CLI, `factory`, lives alongside the manifest CLI and shares its SQLite DB. Skills call it; agents never reimplement what it does.

| Command | Responsibility |
|---|---|
| `factory start <issue>` | create run, artifact directory, state `planned` |
| `factory approve <run_id>` | record contract digest, validation baseline, authorization; state `approved` |
| `factory exec <run_id> -- <cmd>` | run any build/test command under the lock with deadline and process-group cleanup; log output to the artifact dir |
| `factory validate <run_id>` | allocate an attempt, run deterministic phases, parse results, write draft report; attempt → `awaiting_review` (or terminal on deterministic failure) |
| `factory review-input <run_id> <attempt>` | emit the reviewer bundle (§4.9) |
| `factory record-review <run_id> <attempt> <file>` | re-check identity, validate review completeness (§4.9), attach verdict, finalize report; idempotent for the same verdict digest |
| `factory record-manual <run_id> <evidence_id> pass\|fail --note …` | record a human outcome for `manual` evidence, bound to the current report's `head_sha` and contract digest (§5.5) |
| `factory pr <run_id>` | idempotent PR creation/update with report summary (§4.8) |
| `factory status [run_id]` / `factory resume <run_id>` | show state; reconcile and continue an interrupted run |
| `factory revoke <run_id>` | end authorization |

**Execution guarantees:**

- **Build lock:** one lock shared by every worktree, with a lock-wait deadline. Serializes builds and tests across all worktrees.
- **Worktree lock:** one factory operation per worktree at a time (keyed on the worktree path), held for the whole of `validate`, `record-review`, and `pr`. The holder (pid, command, start time) is recorded in the DB so `resume` can tell a live owner from a dead one.
- *As built (#59):* both locks are rows in a `factory_locks` table rather than `flock`s, because Node has no `flock` and the holder has to be in the DB anyway. A lock is claimed in an IMMEDIATE transaction. A holder whose process is gone, or whose pid has been reused (checked by process start time), is taken over by the next caller. Since the DB is per user, the build lock is per user. Reference: [FACTORY_CLI.md](FACTORY_CLI.md).
- **Command deadlines:** per-command timeout; on expiry, the runner kills the **process group** (commands start in their own group), records `error`, and releases the locks.
- **Run deadline:** an absolute `deadline_at` is stored at approval (`approved_at + run-budget`). Commands that **start execution** — `exec`, `validate`, `review-input`, `pr` — check it first and refuse past it (outcome `blocked`, reason `run_deadline`), moving the run to `escalated`. Bookkeeping stays available after expiry: `status`, `revoke`, `resume` (reconciliation only; it won't start checks), `record-review` for a review already in progress, and `record-manual`. This bounds *runner* activity; time an agent spends implementing or reviewing between runner calls is bounded only at the next runner call.
- **Agent budgets:** implementation and review wall-clock and tokens are recorded per phase where available and reported against `run-budget`, but are **advisory** in the first release.
- **Atomic writes:** reports and logs are written to a temp file and renamed.

**Implementation-time commands:** the implementer is instructed to run builds/tests via `factory exec`, so they also queue on the lock. Instructions alone can't enforce this; an optional `PreToolUse` hook can reject Bash calls matching the project's `verify`/`static` commands when they don't go through `factory exec`. The hook ships disabled by default and is enabled per project.

*As built (#64):* the hook (`hooks/factory-exec-guard.sh`) is registered for every project but acts only where the runner keeps its marker: inside the worktree's git directory, while a run is approved, implementing or validating under an active authorization. So it is **on by default during runs** (`exec-hook` defaults to `on`), and a project opts out with `exec-hook: off`. Outside runs it costs one `jq` and one `git` call. The runner now also runs `gh`, for the run's push and PR only, and only as the agent (§4.8); it still never calls a skill or an agent, and issue text still comes from the host. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#the-exec-guard).

### 4.2 Run artifacts live outside the tracked tree

```
{context-path}/{branch}/runs/{run_id}/
  contract.json             approved contract (implementer reads it here)
  attempts/{n}/report.json  per-attempt report (append-only)
  attempts/{n}/logs/…       full command logs
  attempts/{n}/results/…    structured test results (JUnit XML etc.)
  attempts/{n}/review.json  reviewer verdict
```

Nothing the runner produces is written into the worktree, so validation can require a clean tree and committing never changes what a report describes. The approved contract digest is in the DB; the file in the artifact dir is checked against it.

*As built (#59):* `--artifact-dir {dir}` puts a run in `{dir}/{run_id}/`. Without it and without a context-path, artifacts go in the main checkout at `.escapement/runs/{branch}/{run_id}/`, the same in-repo convention `archive-work` follows. `factory start` adds `/.escapement/` to `.git/info/exclude`, so the tree stays clean and the artifacts survive `git worktree remove`.

Existing worktree artifacts (`SCRATCHPAD_*.md`, `SESSION_LOG_*`, `AGENT_CONSTRAINTS.md`) are excluded via the worktree's `.git/info/exclude` — added by `setup-work`, no change to the project's `.gitignore`.

### 4.3 Identity and preconditions

Before running, the runner requires:

- the worktree lock (§4.1); the run is bound to one worktree path, recorded at `factory start`;
- **clean tree:** no tracked modifications, no unignored untracked files;
- contract file digest = approved digest; authorization `active`; run deadline not passed.

The runner captures `HEAD` at the start of the attempt. After checks, and again in `record-review` and `pr`, it verifies **both** that the tree is clean **and** that `HEAD` still equals the captured `head_sha`. A clean tree alone doesn't prove identity — a checkout or commit can change `HEAD` while leaving the tree clean. Any mismatch makes the attempt `error` ("revision changed during validation").

Otherwise outcome `blocked` with the reason.

Every report records:

| Field | Meaning |
|---|---|
| `head_sha` | exact commit validated |
| `merge_base_sha` | merge base with the target |
| `target_ref`, `target_sha` | target branch and its tip at validation time |
| `contract_digest` | approved contract |
| `policy_version` | runner version + digest of project validation settings |
| `lockfile_digest` | digest of dependency lockfile(s) |
| `validation_scope` | `branch` in first release; `merge_result` later |

If a check modified tracked files, the attempt is `error` ("checks are not side-effect free") — the result doesn't describe `head_sha`.

**Dependency policy:** the runner records `lockfile_digest`. If it differs from the digest at the last successful `setup` for this worktree, the runner runs the project `setup` command (e.g. `npm ci`) first under the lock. Projects whose builds can consume stale ignored output should make `static`/`verify` clean-build safe; the runner doesn't attempt to detect stale artifacts.

**Invalidation:** a report applies only while branch head = `head_sha` and contract digest = approved. `create-pr` and the gate re-check before using it. Target movement does **not** invalidate a `branch`-scope report, which is why it is labeled as branch validation (§6.3).

*As built (#61):* a failed precondition (dirty tree, contract mismatch, a required check with no command, invalid settings) is `blocked` before any attempt is allocated. It uses no attempt and leaves the run state alone, so a host that forgot to exclude a scratchpad can fix `.git/info/exclude` and retry; the blocked message names the files. The target tip is `origin/{target_ref}` when that ref exists, else the local branch; `validate` never fetches. Both locks are held for the whole command. The last successful `setup` is recorded per run, so the first attempt of a run always runs `setup`. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#validate).

### 4.4 Phases

| # | Phase | What it produces | Mechanism |
|---|---|---|---|
| 1 | **static** | typecheck, lint, format; forbidden-file edits; predicted-vs-actual drift (warning); test-and-policy change classification (§4.6) | runner |
| 2 | **evidence** | one structured run of `verify` (plus any `command` evidence); per-evidence results resolved from that run | runner |
| 3 | **review** | one fresh-context reviewer over the bundle in §4.9; completeness enforced by the runner | agent, via `review-input` / `record-review` |
| 4 | **scenarios** | hidden scenarios | later |

Deterministic phases stop at the first failure. The reviewer consumes captured outputs; any command it launches goes through `factory exec`.

**Single test run:** `verify` is run once with structured output (project `test-results` setting; JUnit XML as the common format, since most runners can emit it). `test` evidence items are resolved against those results by selector. A selector that matches no executed test is `not_found` (failure); a skipped test is a failure. If `verify` doesn't cover an evidence item's location, the runner runs that item separately under the lock.

**Result freshness:** structured results count only if they provably came from this invocation.

- Each invocation gets a new, empty results directory under `attempts/{n}/results/{invocation}/`, passed to the command via an environment variable (`FACTORY_RESULTS_DIR`) that the project's `test-results` setting references. If a runner can only write to a fixed path, the runner deletes that path before the command and requires it to exist afterward.
- Results must be created after the invocation started (checked by existence in the fresh directory, plus mtime for fixed paths).
- Missing results after a zero exit, or results reporting **zero executed tests**, make the phase `error` — never `pass`.
- Each results file is recorded with its digest, invocation ID, and command, binding evidence to the attempt that produced it.

*As built (#61):* the binding is the report's `invocations` list. JUnit XML is parsed with `fast-xml-parser`. A selector `path::name` matches a case in that file whose name, or the end of its full name, is `name` (`*` is a wildcard; a bare path selects the whole file). Running an evidence item that `verify` doesn't cover separately needs a command for one test, and contracts name no commands (§5.2), so in the first release such an item is `not_found`; this returns with the fix loop. "Forbidden-file edits" has no setting yet and isn't checked. Drift is reported as flags. *(#62:)* when results carry no file paths (node:test's reporter), a selector whose file exists at `head_sha` may match by test name alone, and the report flags it for the reviewer.

### 4.5 Actual-diff tier recomputation

After phase 1, recompute the tier from `merge_base_sha..head_sha`. If any sensitive path is touched or execution policy changed (§4.6), the run is `sensitive` regardless of the plan, the report records why, and the gate may never recommend auto-merge for this run.

### 4.6 Test and policy change classification

At approval, the runner records a baseline at `merge_base_sha`: existing test files and the project's `validation-files` (test/lint config, scripts, CI). Phase 1 classifies every change in the **full** implementation diff:

| Class | Example | Treatment |
|---|---|---|
| **new evidence** | new test file or new test cases | normal; reviewer checks adequacy against criteria |
| **modified assertions** | existing assertions changed, removed, skipped, or loosened | flagged; reviewer must justify each; blocks auto-merge recommendation |
| **execution policy** | `validation-files` changes; `required-checks` weakened | run becomes `sensitive` |

Classification of "new" vs. "modified" uses the diff (added lines in new test blocks vs. changed/removed lines in existing ones); ambiguous cases default to **modified**.

Limits: these measures make tampering visible, not impossible. An agent with shell access can read the context dir and the DB.

*As built (#61):* the baseline isn't stored at approval; `validate` reads it from git at the merge base, so a rebase onto a newer target is classified against the new merge base. Test files are those matching the new `test-files` setting (§8) or named by a contract selector. `test-files`, `validation-files` and `sensitive-paths` are read at both revisions, so a branch can't hide a change by editing the pattern that would catch it. Any change to the factory settings counts as execution policy, with a dropped required check called out. Hunks are classified from `git diff -U0`: only a pure addition that starts a new test block, with no skip/only/todo marker, is new evidence. Modified assertions and policy changes are advisory findings in the report, located as `file:line`, for the reviewer (§4.9) to justify.

### 4.7 Run state machine

```
planned → approved → implementing → validating → validated → pr_open → closed
                          ↑              │
                          └── failed ────┘            (fix loop: next)
any non-terminal → blocked | escalated     (waiting on human)
closed: merged | rejected | abandoned       (terminal)
```

- Transitions are written by the runner in SQLite transactions.
- **Attempts** are allocated atomically (`UNIQUE(run_id, attempt)`), inserted before any command runs, and move through explicit states:

```
checks_running → awaiting_review → finalizing → complete
       │                                  
       └→ complete (deterministic fail / blocked / error: no review needed)
any non-complete → interrupted   (set only by resume, per the rules below)
```

- **Ownership:** each state transition records the owning operation (pid + command) under the worktree lock. "No live process" is meaningful only for an operation that should have one.
- **Resume rules:**

| Found | Meaning | Action |
|---|---|---|
| `checks_running`, owner dead | checks crashed | mark `interrupted` (counts toward budget, partial logs kept); next validation is a new attempt |
| `awaiting_review`, no verdict | checks done, review missing | **not** interrupted — re-issue review; re-check identity first |
| `finalizing`, verdict file present | review done, finalization crashed | re-run finalization idempotently from the stored verdict |
| `complete`, run state not advanced | crash after attempt, before run transition | apply the pending run transition |

- `record-review` is idempotent: re-recording the same verdict (by digest) is a no-op; a different verdict for a `complete` attempt is rejected.
- **Budgets:** attempt count and run deadline are enforced (§4.1); agent time and tokens are summed from recorded phases and reported, advisory in the first release. Resumption never resets any of them.
- *As built (#65):* a crash is reproduced with a test-only fault variable that SIGKILLs the runner at a named point (`ESCAPEMENT_FACTORY_FAULT`, [FACTORY_CLI.md](FACTORY_CLI.md#fault-injection-testing-only)), and `scripts/test-factory.sh` crashes the real runner at each boundary above. Two gaps it found are fixed: a check the dead runner had started kept running (its process group is now recorded on the build lock and killed by `resume` or whoever takes the lock over), and `factory authorization` sent a `finalizing` attempt to `review`, which `review-input` refuses. Its `next` is now `resume` for an attempt left mid-way and `validate` after an interrupted one; skills treat a runner that dies without JSON as a crash and resume.
- In the first release, `failed` stops the run in `escalated` with a report; the fix loop (next) adds the `failed → implementing` edge.

### 4.8 Idempotent PR creation

`factory pr` first looks up an existing open PR for the branch (`gh pr list --head <branch>`). If one exists, it records its number and updates the body; otherwise it creates one and records the number in the same step. A crash between creation and recording is reconciled on resume by the same lookup. `factory pr` holds the worktree lock and re-checks that branch head equals the finalized report's `head_sha` before creating or updating.

*As built (#64):* `gh` runs as the AI agent's GitHub identity (`ESCAPEMENT_AGENT_GH_TOKEN`, from the environment or the user's `~/.config/escapement/agent.env`; without it `pr` is refused, never run as the operator), and the runner pushes only HEAD to the run's branch, never forced. The lookup ignores forks' PRs with the same branch name. The host writes the PR narrative (`--body-file`) and the runner appends its report section between markers, replacing only that section on updates. "Reconciled on resume" became "run `factory pr` again": the lookup finds a PR an earlier call created, and the number is recorded once. Updating an existing PR is bookkeeping, allowed past the deadline and for an escalated run, so its description never shows a stale report. **Rule:** everything the factory writes to GitHub goes through the runner as the agent. That includes later additions such as the fix loop's re-pushes, the gate's recommendation and merge recording. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#pr).

*As built (#80): skills act as the agent too.* The rule reaches every Escapement skill, inside a run or not: Escapement's GitHub work is visibly the agent's, never the operator's. In the operator's setup the GitHub MCP server is authenticated as the agent account, while the `gh` CLI is logged in as the operator, so a skill that called `gh` acted as the operator (PR #79 was opened that way).

- **Issues, PRs, comments, reviews and reads:** skills use the GitHub MCP tools only (`issue_read`, `issue_write`, `add_issue_comment`, `list_issues`, `list_pull_requests`, `pull_request_read`, `create_pull_request`, `update_pull_request`, `pull_request_review_write`, `get_me`). No skill calls `gh` or lists `Bash:gh` among its tools; `manifest/test-skills-github.ts` enforces it, and checks that every GitHub MCP tool a skill names exists on the server.
- **The remaining `gh` use** is the runner's own (`manifest/factory/github.ts`, `pr.ts`): the authorized path's PR lookup, creation and update, and `factory agent`'s account lookup. It always runs with `GH_TOKEN` set to the agent token, so it acts as the agent too. It stays because the runner is a subprocess that hosts other than Claude Code call, with no MCP client.
- **Pushes:** the MCP tools can't push existing commits, and `git push` carries the operator's credentials. Outside a run, skills push with `factory push`: the current branch, with the agent token through the same credential helper as the authorized push, never forced, and never the base branch, origin's default branch, `main` or `master`. It then sets the branch's upstream. Inside a run, `factory pr` pushes, as before.
- **The token goes to github.com only.** Both pushes refuse an origin on any other host, GitHub Enterprise included, with `not_github`, before the token is used (run r1's reviewer found `factory push` would otherwise offer it to a GitLab or self-hosted origin).
- **Commit authorship:** plain `commit-changes` commits with the `factory agent` identity (author and committer), as the authorized path does.
- **Without an agent identity** (`no_agent_token`), plain `commit-changes` and `create-pr` fall back to the operator's own git identity and `git push`, and say so in one line. Off github.com (`not_github`) the push falls back the same way. Escapement is a multi-project plugin, and refusing would break the plain skills for every project without an agent identity; PRs, issues and comments still come from the MCP server's account. A configured identity that fails (`agent_env_permissions`, a failed lookup or push) is reported and never retried as the operator. The authorized path never falls back: without the identity, `do-work` stops before implementing.

### 4.9 Reviewer bundle and completeness

**Bundle** (`factory review-input`):

- the issue text and the approved contract;
- the exact diff `merge_base_sha..head_sha`;
- a **read-only source snapshot at `head_sha`**, exported by `review-input` (`git archive head_sha`) into `attempts/{n}/source/`, with its tree digest recorded. The reviewer reads this snapshot, not the live worktree — the worktree lock is released between CLI calls, so the live tree can't establish what the reviewer actually read. The verdict carries the snapshot digest, and `record-review` rejects a verdict whose digest doesn't match;
- the draft report: per-evidence `executed` results, change classification, tier and reasons, flags;
- paths to full logs and structured results;
- the list of judgments required (below).

**Required response** — a structured verdict the runner validates before finalizing:

```json
{
  "source_digest": "sha256:…",
  "evidence": [
    { "id": "AC-1.e1", "supports_criterion": "yes | no | partial", "rationale": "…" },
    { "id": "AC-3.e1", "procedure_adequate": "yes | no", "rationale": "…" }
  ],
  "sensitive_paths": [
    { "path": "src/auth/refresh.ts", "signoff": "approve | concern", "rationale": "…" }
  ],
  "modified_assertions": [
    { "location": "tests/auth/refresh.test.ts:88", "justified": true, "rationale": "…" }
  ],
  "findings": [
    { "severity": "blocking | advisory", "detail": "…", "location": "…" }
  ]
}
```

**Completeness rules** enforced by `record-review`:

- `source_digest` matches the snapshot issued for this attempt;
- every evidence ID in the contract has exactly one judgment; no unknown IDs. Executable evidence takes `supports_criterion`; `manual` evidence takes `procedure_adequate` — the reviewer judges whether the proposed human check would demonstrate the criterion, not whether it passed;
- every actual sensitive path in the diff has a sign-off;
- every modified-assertion location from phase 1 has a justification entry;
- any missing, unknown, or malformed entry → verdict rejected, attempt stays `awaiting_review`;
- any `supports_criterion` of `no` or `partial`, `procedure_adequate` of `no`, sensitive `concern`, unjustified modified assertion, or blocking finding → outcome `fail`.

The agent supplies the judgment; the runner guarantees it is complete.

*As built (#62):*
- **Bundle.** It lives in `attempts/{n}/review/`: `bundle.json`, `diff.patch`, `source/` and `issue.md`. The issue text comes only from the host's `--issue-file`; the runner never fetches issues.
- **Snapshot digest.** It covers each file's path, type and content. It is recorded in an event, so no schema change was needed.
- **Policy sign-offs.** Execution-policy changes (`policy:{path}`) need a sign-off like sensitive paths, because they make the run sensitive (§4.5).
- **Rejections.** A rejected verdict changes nothing; the rejection is logged as an event.
- **Accepted verdict.**
  - It is stored as `review.json`, and the draft is kept as `report.draft.json`.
  - `report.json` becomes the final report, with a `review` block.
  - Each fail condition becomes a blocking finding.
  - The verdict digest is taken over canonical JSON, so formatting doesn't matter.
- **The reviewer is data.** It is `prompts/factory/validation-reviewer.md` plus the verdict schema, and `factory prompt reviewer` finds it. `agents/validation-reviewer.md` is the Claude Code wrapper. The host runs `record-review`, not the reviewer.

Reference: [FACTORY_CLI.md](FACTORY_CLI.md#review-input).

---

## 5. The Validation Contract

### 5.1 Evidence types

| Type | Spec | Result |
|---|---|---|
| `test` | `selector` (file + test name/pattern), optional `cwd`, `timeout_s` | resolved from structured results: passed / failed / skipped / not_found |
| `command` | `run`, `cwd`, `timeout_s`, `expect.exit_code`, optional `expect.stdout_matches` / `stdout_not_matches` | exit code, predicate results, log path |
| `manual` | `instructions` | `pending_manual` until a human records an outcome |

- Skipped or not-found is failure.
- Each item is `kind: "new_behavior" | "regression"`.
- Two judgments per item: **executed** (runner, deterministic) and **supports_criterion** (reviewer). Both appear in the report.

### 5.2 Contract schema

```json
{
  "version": 1,
  "run_id": "esc#42-r1",
  "issue": 42,
  "manifest_id": "esc#42",
  "risk_tier_proposed": "standard",
  "criteria": [
    {
      "id": "AC-1",
      "text": "Expired refresh tokens return 401",
      "evidence": [
        { "id": "AC-1.e1", "type": "test", "kind": "new_behavior",
          "selector": "tests/auth/refresh.test.ts::rejects expired token" }
      ]
    },
    {
      "id": "AC-2",
      "text": "Existing refresh flow still works",
      "evidence": [
        { "id": "AC-2.e1", "type": "test", "kind": "regression",
          "selector": "tests/auth/refresh.test.ts::refreshes valid token" }
      ]
    },
    {
      "id": "AC-3",
      "text": "Docs describe the refresh flow",
      "evidence": [
        { "id": "AC-3.e1", "type": "manual", "kind": "new_behavior",
          "instructions": "docs/auth.md has a 'Refresh' section matching the new behavior" }
      ]
    }
  ],
  "predicted_files": ["src/auth/refresh.ts", "tests/auth/refresh.test.ts"]
}
```

Contracts name no commands in the first release: every check comes from project settings (§8), so a contract can't skip or narrow `required-checks`. A narrowed `verify` for quick feedback returns with the fix loop (§6.2). Contract changes require re-approval (new digest, new authorization, same `run_id`).

*As built (#60):* the contract, report (§5.3), verdict (§4.9) and readiness (§3.1) documents have published JSON Schemas in `schemas/factory/`, and the runner validates against those same files. Each document carries `"version": 1`; the contract may also carry `risk_reasons` for a proposed tier. `issue` and `manifest_id` are optional, so hosts with their own work-item IDs need neither.

### 5.3 Report schema

`attempts/{n}/report.json`:

```json
{
  "run_id": "esc#42-r1",
  "attempt": 2,
  "status": "complete",
  "outcome": "fail",
  "validation_scope": "branch",
  "head_sha": "d4e5f6…",
  "merge_base_sha": "a1b2c3…",
  "target_ref": "develop",
  "target_sha": "c7d8e9…",
  "contract_digest": "sha256:…",
  "policy_version": "factory@1.0.0+settings:sha256:…",
  "lockfile_digest": "sha256:…",
  "tree_clean_after": true,
  "tier": { "proposed": "standard", "actual": "standard", "reasons": [] },
  "changes": { "new_evidence": 1, "modified_assertions": 0, "execution_policy": 0 },
  "phases": [
    { "name": "static", "outcome": "pass", "duration_s": 41, "log": "logs/static.log" },
    { "name": "evidence", "outcome": "fail", "duration_s": 132, "log": "logs/verify.log" }
  ],
  "evidence": [
    { "id": "AC-1.e1", "executed": "failed", "supports_criterion": null,
      "excerpt": "expected 401, received 500" }
  ],
  "findings": [
    { "id": "evidence:AC-1.e1", "severity": "blocking",
      "detail": "rejects expired token fails: expected 401, got 500",
      "evidence_digest": "sha256:…" }
  ],
  "flags": [],
  "budget": { "attempts_used": 2, "wall_clock_s": 1840, "tokens": 412000 }
}
```

`evidence_digest` hashes normalized failure output so the fix loop can distinguish "same test, different failure" from "no change".

### 5.4 Outcomes

| Outcome | Meaning |
|---|---|
| `pass` | all phases passed; reviewer found no blocking issues |
| `fail` | check failure or blocking review finding; actionable by the implementer |
| `blocked` | cannot validate: dirty tree, contract mismatch, inactive authorization, missing config |
| `error` | infrastructure: crash, deadline, lock-wait exceeded, checks modified the tree |
| `pending_manual` | all automatable evidence passed; `manual` items await a human |
| `interrupted` | attempt didn't complete (set on resume) |

### 5.5 Completing manual evidence

`pending_manual` means every automatable item passed, the reviewer judged each manual procedure adequate, and human outcomes are outstanding.

- The operator records each outcome with `factory record-manual <run_id> <evidence_id> pass|fail --note …`.
- Each record is bound to the current finalized report's `head_sha` and contract digest. A record for a superseded revision or contract is rejected; a new commit invalidates earlier manual records along with the report.
- When every manual item is recorded `pass`, the report's outcome moves `pending_manual → pass` (appended as a new report revision; the original stays). Any `fail` → `fail`.
- Manual outcomes are stored as `factory_events` (`kind: 'manual_outcome'`) with the recorder and note.

*As built (#62):* `pending_manual` moves the run to `validated`, as `pass` does. The PR can open while manual outcomes are outstanding, and the report shows them as pending.

*As built (#64):* a revision is `attempts/{n}/report.r{k}.json`, with `revision`, `supersedes` and `manual_outcomes` (optional report fields). Any single `fail` resolves the report at once, even with other manual items unrecorded; it adds a blocking finding `manual:{id}` and escalates the run. Recording the same outcome again is a no-op; a different one replaces it until the report resolves. The result says when the open PR needs `factory pr` to refresh its report section. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#record-manual).

---

## 6. The Authorized Path, Fix Loop, and Gate

### 6.1 Authorized path (first release)

With an active authorization, `do-work`:

1. works through the scratchpad, running builds/tests via `factory exec`;
2. commits via `commit-changes` (no confirmation);
3. calls `factory validate`, then the reviewer, then `factory record-review`;
4. on `pass` / `pending_manual`: pushes the branch and calls `factory pr` → state `pr_open`, notify operator;
5. on `fail` / `blocked` / `error`: state `escalated`, notify operator with the report; stop.

No new agent role; the existing confirmations are skipped only under authorization.

*As built (#64):* `do-work` asks `factory authorization` first and routes on its `next`. `validate-work` (new) runs step 3, re-running the reviewer at most twice on an incomplete verdict. `create-pr` hands its title and narrative to `factory pr`. Step 5 also covers what the runner can't see: a blocked precondition or a blocker the implementer can't resolve goes through the new `factory escalate`, so the run shows why it stopped. Without an agent identity (`ESCAPEMENT_AGENT_GH_TOKEN`), `do-work` stops before implementing. Notification is a push notification plus the session's final message. `archive-work` copies the contract, reports, verdicts and PR body into the archive and closes the run with `factory archive --close`, as merged or abandoned from its PR, so the worktree can start its next run.

### 6.2 Fix loop (next)

On `fail`, the implementer receives findings only, fixes, commits, and re-validates.

- **Caps:** max attempts (default 3) and run budget. Exhausted → `escalated`.
- **Stuck:** a blocking finding whose `evidence_digest` is unchanged across two consecutive attempts → `escalated`. A repeated finding ID with changing evidence is progress, not stuck.
- **Regression:** evidence that passed in an earlier attempt and now fails is flagged.
- `blocked` / `error` always escalate; they aren't the implementer's to fix blindly.
- **Narrowed verify between attempts:** a contract may name a faster `narrow_verify` (only the tests relevant to the criteria) so fix attempts get quick feedback. It never replaces a required check: the attempt that can produce `pass` always runs every `required-checks` command in full. Deferred from the first release (#60): there, validation runs once per attempt and `verify` is required by default, so a narrowed command would never run.

### 6.3 Gate

**Report-only (next):** compute a recommendation, record it, always ping.

`auto_merge` recommended only if all hold: actual tier `standard`; outcome `pass`; no modified-assertion or policy flags; report head = branch head; contract digest matches authorization; no advisory findings above configured severity; diff size and attempt count under thresholds. Otherwise `ping` with reasons.

**Before enforcing mode (later), additionally required:**

- **merge-result validation** — validate the proposed merge of `head_sha` into the current `target_sha`, not just the branch;
- **conditional merge** — merge only if branch head and target tip still equal the validated SHAs;
- the §7.4 promotion criteria.

---

## 7. Metrics

### 7.1 Tables

In the shared per-user manifest SQLite DB, added by schema migration 2 (#59). As built, `factory_runs` also records `work_item` (the external ID given to `factory start`), `artifact_dir` and `state_reason`. `factory_authorizations` allows only one `active` row per run, and a fifth table, `factory_locks`, holds the runner's locks (§4.1).

```sql
CREATE TABLE factory_runs (
  run_id            TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  worktree_path     TEXT NOT NULL,
  branch            TEXT NOT NULL,
  target_ref        TEXT NOT NULL,
  deadline_at       TEXT,           -- set at approval; enforced by runner
  issue_number      INTEGER,
  manifest_id       TEXT,
  work_type         TEXT,
  state             TEXT NOT NULL,
  tier_proposed     TEXT,
  tier_actual       TEXT,
  contract_digest   TEXT,
  policy_version    TEXT,
  gate_recommendation TEXT,
  gate_reasons_json TEXT,
  operator_action   TEXT,        -- merged_as_is | changes_requested | rejected | abandoned
  pr_number         INTEGER,
  merge_sha         TEXT,
  archive_path      TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);

CREATE TABLE factory_authorizations (
  run_id            TEXT NOT NULL REFERENCES factory_runs(run_id),
  contract_digest   TEXT NOT NULL,
  baseline_json     TEXT NOT NULL,   -- test/policy baseline at approval
  authorizes_json   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','ended','revoked','superseded')),
  approved_at       TEXT NOT NULL,
  ended_at          TEXT,
  PRIMARY KEY (run_id, contract_digest)
);

CREATE TABLE factory_attempts (
  run_id            TEXT NOT NULL REFERENCES factory_runs(run_id),
  attempt           INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('checks_running','awaiting_review','finalizing','complete','interrupted')),
  owner_json        TEXT,           -- {pid, command, started_at} of the current operation
  verdict_digest    TEXT,
  outcome           TEXT,
  head_sha          TEXT NOT NULL,
  target_sha        TEXT,
  contract_digest   TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  failed_phase      TEXT,
  findings_json     TEXT,
  flags_json        TEXT,
  report_path       TEXT,
  duration_s        INTEGER,
  tokens            INTEGER,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  PRIMARY KEY (run_id, attempt)
);

CREATE TABLE factory_events (
  id                INTEGER PRIMARY KEY,
  run_id            TEXT REFERENCES factory_runs(run_id),
  kind              TEXT NOT NULL CHECK (kind IN
                      ('readiness','critique_finding','state_change','gate',
                       'operator_action','manual_outcome','defect','revert')),
  detail_json       TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 7.2 Event conventions

- `critique_finding`: `{finding, severity, accepted, plan_change, tokens}` — measures critic value directly, not only via later validation failures.
- `defect`: explicit link from a later bug issue or incident to a `run_id` / `merge_sha`, with how it was attributed (label, manual, heuristic).
- `revert`: a revert commit linked to a `merge_sha`.

### 7.3 Questions it answers

Failure phase by work type and tier; attempts and cost to convergence; critic findings accepted and their downstream effect; tier accuracy (proposed vs. actual); interruption and error rates. All segmented by `policy_version`.

### 7.4 Promotion to enforcing mode (later)

Gate–operator agreement is not sufficient. The key metric is the **false auto-merge rate**: auto-merge recommendations followed by changes requested, rejection, revert, or an attributed defect.

Before evaluating any promotion cohort, a short pre-registration note must fix: the cohort (project, work type, policy version), observation window after merge, acceptable false auto-merge rate and how uncertainty is handled at small sample sizes, and how a sample of auto-merge-eligible runs is independently audited. Writing that note is a later-tier task; with a single operator, cohorts will be small for a long time, and that is acceptable.

---

## 8. Project Configuration

Extends `## Escapement Settings` in each project's CLAUDE.md:

```markdown
## Escapement Settings

- **context-path**: ../myproject-ctx
- **base-branch**: develop
- **setup**: npm ci
- **static**: npm run typecheck && npm run lint
- **verify**: npx jest --runInBand --reporters=default --reporters=jest-junit
- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml
- **required-checks**: static, verify
- **sensitive-paths**: src/auth/**, migrations/**, src/billing/**, .github/**
- **validation-files**: jest.config.*, tsconfig*.json, .eslintrc*, package.json
- **test-files**: *.test.*, *.spec.*, tests/
- **max-attempts**: 3
- **command-timeout**: 15m
- **lock-timeout**: 30m
- **run-budget**: 2h
- **exec-hook**: on
- **gate-mode**: report-only
```

All keys optional. Missing `static`/`verify` → `blocked` ("not configured"). `required-checks` cannot be narrowed by a contract. `test-results` should reference `$FACTORY_RESULTS_DIR` (for jest-junit, set `JEST_JUNIT_OUTPUT_DIR` from it). If a test runner can only write to a fixed path inside the worktree, it must be gitignored; the runner clears it before each invocation and moves results into the artifact dir afterward (§4.4). `run-budget` sets the enforced run deadline; agent time and token figures are advisory.

*As built (#60):* settings are read from the CLAUDE.md of the run's worktree whenever a command needs them, not copied per run. Each report records their digest in `policy_version`, and a branch that changes them, or weakens `required-checks`, is an execution-policy change (§4.6), so a weakened setting is flagged for review rather than silently used. `factory check` reports a required check with no command as a readiness question. Reference: [FACTORY_CLI.md](FACTORY_CLI.md#settings).

*As built (#64):* `exec-hook` defaults to `on`; it governs the exec guard during runs (§4.1).

*As built (#61):* `test-files` (glob list) names test files for classification (§4.6); its default covers common layouts (`*.test.*`, `*.spec.*`, `test/`, `tests/`, `__tests__/`, `test_*.py`, `*_test.py`, `*_test.go`). `base-branch` is the default target for `factory start`.

---

## 9. Changes to Existing Skills

| Component | Change | Release |
|---|---|---|
| `factory` CLI (new, `manifest/`) | runner, run state, attempts, reports, PR idempotency, metrics | first |
| `setup-work` | readiness, light context, proposed tier, contract, `.git/info/exclude` entries, `factory start`/`approve` | first |
| `do-work` | authorized path (§6.1) | first |
| `validate-work` (new) | thin skill: `factory validate` → reviewer → `factory record-review`; runnable standalone | first |
| `commit-changes` | skip confirmation under matching authorization | first |
| `create-pr` | under authorization delegates to `factory pr`; verifies report head = branch head | first |
| `archive-work` | archive run artifact dir; record `archive_path` | first |
| agents | `validation-reviewer` | first |
| `do-work` | fix loop (§6.2) | next |
| `setup-work` + `plan-critic` agent | critique loop (§3.5) | next |
| gate + `manifest-sync` | report-only recommendation; operator action and merge SHA recording | next |
| `PreToolUse` exec hook | optional enforcement of `factory exec` | first (as built: on during runs, opt out per project) |

---

## 10. Build Order

Status as of 2026-11-16; tracked in #66.

1. **#57** — context-path detection. **Done** (PR #68). Found alongside it and also done: **#67**, the manifest skills run their CLI through a plugin-root wrapper, `scripts/manifest.sh` (PR #69).
2. **#58 Shared manifest location + versioned schema** — one per-user manifest database independent of plugin and project location; `PRAGMA user_version` and ordered migrations replacing `ensureSchema` (§2.5). **Done.**
3. **#59 `factory` CLI core** — run/attempt/authorization tables, state machines, `start`/`approve`/`exec`/`status`/`resume`/`revoke`, build and worktree locks, command and run deadlines, process-group cleanup, artifact dir. **Done.** Locks are SQLite rows (§4.1); CLI reference in [FACTORY_CLI.md](FACTORY_CLI.md).
4. **#60 Contract + settings + readiness + tiers** — schema, evidence types, settings parsing. **Done.** Published JSON Schemas in `schemas/factory/`, `factory check` (readiness) and `factory schema`; contracts name no commands (§5.2).
5. **#61 `factory validate`** — identity (clean tree + HEAD), setup policy, static + evidence phases, fresh results dirs, single structured test run, change classification, actual-diff tier, draft reports. **Done.** Blocked preconditions use no attempt (§4.3); the classification baseline comes from git (§4.6); new `test-files` setting (§8).
6. **#62 Reviewer** — `validation-reviewer` agent, bundle, `record-review` completeness checks and idempotency. **Done.** The reviewer is a prompt plus the verdict schema, with the Claude Code agent as a thin wrapper; policy changes need a sign-off; `pending_manual` validates the run (§4.9, §5.5).
7. **#63 `setup-work`** produces contract + authorization. **Done.** Offered at plan approval only when the project's required checks are configured; the run is created on approval; new `factory exclude`, settings-only `factory check`, `manifest.sh readiness` (§3.1, §3.6).
8. **#64 Authorized path** — `do-work`, `commit-changes`, `create-pr`, `factory pr`, `record-manual`. **Done.** Also `factory authorization`, `agent`, `escalate` and `archive`, and the `validate-work` skill. GitHub work runs as the AI agent's identity, through the runner (§4.8). The exec guard is on during runs (§4.1). `archive-work` closes runs.
9. **#65 Release acceptance test** — a real issue end to end, plus deliberate interruptions at each boundary: during checks, between checks and review, during finalization, and between PR creation and recording. The first release is complete only when this passes; fix what breaks before moving on. **Done.**
   - **Infrastructure:** fault injection, crash tests at every boundary and the fixes they found (§4.7). Escapement became a factory project of its own.
   - **The real run:** #80 on Escapement, every boundary interrupted once. Two runs: r1 was failed by its reviewer, rightly, for a token leak the tests missed. r2 was merged as PR #82, opened by the agent.
   - **Fixed from it:** PR updates use the REST API, since `gh pr edit` fails where classic Projects are deprecated, and `check` works on a detached HEAD (both #83). Report text escapes `<` and `>` (3.13.1).
   → *first release complete*

**Host-agnostic interface (added 2026-11-15 to #59–#62).** The factory must be usable by hosts other than the Escapement skills, for example Escapement Studio calling it as a subprocess. Requirements: `--json` output on every command; external work-item IDs (no required manifest `work_items` row; `manifest_id` optional in the contract); storage passed explicitly (`--project-root`, optional artifact-dir override); invocation through a plugin-root wrapper (`scripts/factory.sh`) with no skill calls from the runner; contract, report and verdict schemas published as standalone JSON Schema; the `.git/info/exclude` obligation for hosts documented and tested; the reviewer defined as a prompt plus verdict schema, with the Claude Code agent as a thin wrapper.
10. **Bounded fix loop.**
11. **Plan critique**, one round.
12. **Gate, report-only.**
13. **Later:** merge-result validation, enforcing gate, async escalation, hidden scenarios, test-first, outer loop.

---

## 11. Risks Accepted for the First Release

- `factory exec` adoption by the implementer is instruction-based; the hook (on during runs) catches only the project's own `static` and `verify` commands at the start of a command.
- "New vs. modified" test classification is heuristic; ambiguity defaults to the stricter class.
- Branch validation can pass while the combined merge fails; the report says so, and the operator merges.
- Stale ignored build output isn't detected; projects own clean-build-safe commands.
- Run artifacts are hidden from git, not from the agent.
- Agent wall-clock and token budgets are reported, not enforced; the run deadline bounds only runner activity.
- The contract and its tests may themselves be inadequate (§1.3); only plan approval and later defect attribution check that.

---

## 12. Open Questions

1. **Critic model diversity** — different framing vs. different model; A/B once critique events exist.
2. **Contract amendments mid-build** — escalation only, or critic-approved amendment under the same run?
3. **Reviewer vs. `/code-review`** — reuse inside the review phase, or a narrower contract-aware reviewer?
4. **Work-type taxonomy** — from labels, plan, or diff?
5. **Evidence for non-test criteria** — UI, performance, docs: where is `manual` the honest answer?
6. **Runner language/location** — extend the existing TypeScript manifest CLI (shared DB, existing tooling) vs. a separate package. Default: extend.

---

## 13. Review Log

### r2 — First independent review

Direction judged sound. Adopted: revision-bound reports; typed evidence with `executed` vs. `supports_criterion`; actual-diff tier recomputation; non-binary outcomes, deadlines, resumable budgets, evidence-digest stuck detection; full-diff anti-gaming with approval held outside the worktree; run identity in metrics and false auto-merge rate as the unlock metric; run authorization for confirmation stops; single reviewer. Plan critique kept as "next", one round, rather than deferred until measured — it can only be measured by running it, and it was an explicit operator goal.

### r3 — Second independent review

Judged a refinement of a sound design; findings concerned making guarantees operational.

| # | Finding | Change |
|---|---|---|
| 1 | Skills can't guarantee locking, deadlines, cleanup | Deterministic `factory` runner owns execution, lock, process-group kill, parsing, reports; implementation-time commands via `factory exec`, optional hook (§4.1) |
| 2 | Branch report doesn't establish integration correctness | `target_ref`/`target_sha` recorded; reports labeled `validation_scope: branch`; merge-result validation and conditional merge required before enforcing (§4.3, §6.3) |
| 3 | Clean-tree rule conflicted with contract and scratchpads in the worktree; post-check identity unspecified | Run artifacts in the context dir; worktree artifacts excluded via `.git/info/exclude`; post-check clean-tree verification; lockfile digest and setup policy; full logs (§4.2, §4.3) |
| 4 | Any test change → sensitive made ordinary test-writing ineligible | Graded classification: new evidence / modified assertions / execution policy (§4.6). **This was oscillation:** r1 checked too late, r2 overcorrected; r3 keeps r2's full-diff scope with r1-appropriate treatment of new tests. Considered settled. |
| 5 | First release couldn't meet "two touches" because `do-work` still prompts | Minimal authorized path through `do-work` in the first release; fail → persist and stop (§6.1) |
| 6 | Durable records but undefined state transitions and recovery | Run state machine, atomic attempts, interrupted-attempt handling, idempotent PR creation, authorization lifecycle bound to repo/branch/target/contract (§3.6, §4.7, §4.8) |
| 7 | Metrics insufficient to justify autonomy | Segmentation by policy version; explicit `defect`/`revert` events; critique findings recorded with acceptance and plan change. Statistical pre-registration deferred to a pre-enforcement note (§7.4) — proportionate to a later-tier decision |
| — | Repeated test execution; tiers' effect unspecified | Single structured test run resolving evidence; two tiers in first release with defined effects (§3.3, §4.4) |

### r3.1 — Third independent review (blind)

Judged buildable; findings concerned boundaries between components. None reversed an earlier decision. Applied as targeted edits rather than a rewrite.

| # | Finding | Change |
|---|---|---|
| 1 | Stale structured results could yield a false pass | Fresh results dir per invocation via `FACTORY_RESULTS_DIR`; results must be newly created; zero executed tests or missing results → `error`; results bound to invocation by digest (§4.4) |
| 2 | Run budget didn't bound the run | Absolute `deadline_at` enforced at every runner call; agent time and tokens explicitly advisory (§1.4, §4.1, §11) |
| 3 | Recovery couldn't distinguish checks-done-awaiting-review from a crash | Attempt states `checks_running → awaiting_review → finalizing → complete`; recorded ownership; per-state resume rules; idempotent `record-review` (§4.7) |
| 4 | Clean tree doesn't prove revision identity; other sessions could modify the worktree; reviewer saw too little | Worktree lock for all factory operations; HEAD re-checked after checks, at review, and at PR; reviewer bundle includes issue, contract, exact diff, source at `head_sha` (§4.1, §4.3, §4.9) |
| 5 | No deterministic completeness check on the review | Structured verdict; runner rejects missing/unknown evidence judgments, missing sensitive-path sign-offs, unjustified modified assertions (§4.9) |
| 6 | Manifest code resolves the plugin's own project and can't upgrade schema | Verified in `manifest/init.ts:16` and `:74`. Added as prerequisites and build step 2 (§2.5, §10) |
| — | Contract adequacy limit should be prominent | Stated in §1.3 and §11 |

### r3.2 — Follow-up review of r3.1

Judged ready to implement. Four localized decisions applied:

| Finding | Change |
|---|---|
| Reviewer reads the live worktree after the lock is released | Read-only `git archive` snapshot at `head_sha` per attempt; verdict must carry its digest (§4.9) |
| No operation for recording manual outcomes; reviewer can't judge a check that hasn't happened | Reviewer judges `procedure_adequate`; `factory record-manual` records the human result bound to revision and contract (§4.9, §5.5) |
| "Every runner command refuses" past deadline was too broad | Deadline blocks execution only; status, revoke, resume reconciliation, and recording remain available (§4.1) |
| "First release complete" preceded the interruption test | The interrupted vertical slice is the release acceptance test (§10, step 9) |

Process note: design is settled for the first release. Next learning comes from build step 9.
