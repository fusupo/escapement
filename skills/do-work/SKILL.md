---
name: do-work
description: Execute development work from a scratchpad, tracking progress with TodoWrite and making atomic commits. This skill MUST be invoked as the first action when user says "start work on issue #X", "do work on issue #X", "work on issue #X", "continue work", "resume work", or "keep working". Do not fetch issue details or plan manually.
tools:
  - mcp__serena__*
  - Read
  - Edit
  - Write
  - Bash:git *
  - Bash:bash *
  - Glob
  - Grep
  - TodoWrite
  - AskUserQuestion
  - Skill
  - Task
  - LSP
  - EnterPlanMode
  - PushNotification
---

# Work Session Skill

## Purpose

Execute implementation work from a scratchpad in a structured, trackable way. This skill loads the implementation plan, creates TodoWrite items for visibility, works through tasks systematically, and coordinates commits after task completion.

## Natural Language Triggers

This skill activates when the user says things like:
- "Start work on issue #42" (default trigger)
- "Do work on issue #42"
- "Work on issue #42"
- "Continue work on this issue"
- "Resume work"
- "Keep working"
- "Let's work through the scratchpad"
- "Work on the next task"
- "Pick up where we left off"

## Workflow Execution

### Phase 0: Check Scratchpad Exists (Self-Correction)

**Before proceeding with work, verify scratchpad exists:**

1. **Detect Scratchpad:**
   - Look for `SCRATCHPAD_{issue_number}.md` in project root
   - If issue number provided, look for specific scratchpad

2. **If scratchpad NOT found:**
   ```
   ❌ No scratchpad found for issue #{number}

   Would you like to run setup-work first?
   ```

   Use AskUserQuestion:
   ```
   AskUserQuestion:
     questions:
       - question: "No scratchpad found. Run setup-work to initialize?"
         header: "Setup Required"
         multiSelect: false
         options:
           - label: "Yes, run setup-work"
             description: "Create scratchpad and branch for this issue"
           - label: "No, create manually"
             description: "I'll set up the scratchpad myself"
   ```

   If user chooses "Yes":
   ```
   Skill: setup-work
   args: "{issue_number}"
   ```

   **STOP here** - setup-work will create scratchpad and can chain to do-work after.

3. **If scratchpad exists:**
   - Proceed to Phase 1 (normal work flow)

### Phase 0.5: Authorized Run Check

A factory run approved with setup-work's "Approve + authorize run" lets this session carry the work from the approved plan to an open PR with no further questions: the operator's touches are plan approval and merge (docs/FACTORY_DESIGN.md §6.1). Ask the runner whether this worktree has one:

```bash
FACTORY="${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh"
bash "$FACTORY" --check && bash "$FACTORY" --json authorization
```

- **`--check` fails, or `.result.matched` is false:** not authorized. Every phase below runs exactly as written. If `.result.run_id` is set, a run exists but can't continue on its own (`.result.reasons`, such as `run_halted` or `contract_changed`). Say so in one line, with the reason from `factory status '{run_id}' --json` (`.result.run.state_reason`), then continue interactively. An escalated run whose latest attempt failed or errored can be taken back: see **Escalated after a failed attempt** below. Any other escalated or blocked run isn't resumed: the operator closes it (archive-work, or `factory archive '{run_id}' --path … --abandon`), and a new attempt at the work starts with setup-work.
- **Matched:** authorized. Note `run_id`, `artifact_dir` and `next`, and check the agent identity commits will carry:
  ```bash
  bash "$FACTORY" --json agent
  ```
  If it fails (`no_agent_token`, or `agent_env_permissions`), stop before any work: "Factory run {run_id} commits and opens its PR as the AI agent: put ESCAPEMENT_AGENT_GH_TOKEN in ~/.config/escapement/agent.env (chmod 600) or export it, then resume." Nothing is escalated; this is setup, not a failure of the run.

**Escalated after a failed attempt.** When `.result.state` is `escalated`, the run has no PR yet (`.result.run.pr_number` is null in `factory status '{run_id}' --json`), and the latest attempt there (`.result.attempts`, the last one) is `complete` with outcome `fail` or `error`, the run stopped to wait on the operator (docs/FACTORY_DESIGN.md §6.2). A run whose PR is open (escalated by a failed manual check, for example) can't go back to implementation yet (#97): offer only abandon and start over. Nor can a run escalated for a rejected manual procedure (`state_reason` names a `judgment:` finding as a rejected manual procedure, #99): the reviewer judged the contract's own instructions inadequate, no change to the code can fix them, and only a new plan under a new approval can. Offer only abandon and start over, and say that in plain words. Tell them in plain words why (`.result.run.state_reason`, and the attempt's blocking findings and error from its report), then ask; never show them runner commands:

```
AskUserQuestion:
  question: "Factory run {run_id} stopped after attempt {n} {failed | errored}: {why, in plain words}. What now?"
  header: "Run stopped"
  options:
    - label: "Fix it and continue"
      description: "Keep this run, its approved plan and its remaining budget: fix what the last attempt found, then validate again"
    - label: "Abandon"
      description: "Close this run; the branch and commits stay"
    - label: "Start over"
      description: "Close this run and plan the work again with setup-work, under a new approval"
```

- **Fix it and continue:** take the run back, with the operator's words as the reason (single-quoted; a `'` inside is written `'\''`):
  ```bash
  bash "$FACTORY" --json continue '{run_id}' --reason '{what the operator decided}'
  ```
  On `.ok`, ask `factory authorization` again: it matches with `next: implement` and a `fix`, and the Authorized Path takes it from there. If it is refused, say why in plain words and offer the other two options: `run_deadline` (the run's time is up), `attempt_budget` (every attempt is used), `not_authorized` or `contract_mismatch` (the approval no longer holds), `no_failed_attempt` (nothing to fix), `has_pr` (the PR is already open).
- **Abandon:** close the run with archive-work, or `factory archive '{run_id}' --path … --abandon`.
- **Start over:** abandon it as above, then invoke setup-work for the issue.

**The authorized path.** Follow the Authorized Path section below instead of the confirmations in Phases 1–6. In short:

| `next` | Do |
|---|---|
| `implement` | work through the unchecked tasks, then validate. With a `fix` (the run is back after a failed attempt), fix its findings first (step A) |
| `validate`, `resume`, `review` | validate (validate-work picks up where the attempt stopped, after a crash too) |
| `pr`, `refresh_pr` | open or refresh the PR (create-pr) |
| `await_merge` | nothing: the PR is open and shows the current report. Report its number and stop |

### Phase 1: Validate Setup

1. **Load Scratchpad:**
   - Scratchpad confirmed to exist from Phase 0
   - Read full scratchpad content
   - Parse implementation checklist
   - Identify completed vs pending tasks

2. **Verify Branch:**
   - Check current branch matches expected feature branch
   - If not, offer to switch:
     ```
     AskUserQuestion:
       question: "Switch to feature branch {branch-name}?"
       options:
         - "Yes, switch branches"
         - "No, stay on current branch"
     ```

3. **Resume Detection:**
   - Check Work Log for previous session
   - Identify last task in progress
   - Offer to resume or start fresh

### Phase 2: Initialize TodoWrite

Create TodoWrite items from scratchpad checklist:

```
TodoWrite:
  todos:
    - content: "{Task 1 description}"
      status: "completed"  # if already done
      activeForm: "{Task 1 active description}"
    - content: "{Task 2 description}"
      status: "in_progress"  # current task
      activeForm: "{Task 2 active description}"
    - content: "{Task 3 description}"
      status: "pending"
      activeForm: "{Task 3 active description}"
    ...
```

**Sync Strategy:**
- TodoWrite = Live UI progress (transient, session-based)
- Scratchpad = Persistent record with notes (survives sessions)
- Keep both in sync: when TodoWrite updates, update scratchpad checkboxes

### Phase 3: Work Loop

For each unchecked item in the Implementation Checklist:

#### 3.1 Start Task

1. **Update TodoWrite:**
   - Mark current task as `in_progress`
   - All others remain `pending` or `completed`

2. **Display Task:**
   ```
   📍 Working on: {task description}
      Files: {affected files}
      Why: {rationale}
   ```

3. **Update Scratchpad Work Log:**
   ```markdown
   ### {Date} - Session Start
   - Starting: {task description}
   ```

#### 3.2 Implement Task

Under an authorized run, the Authorized Path (step A) replaces the questions below.

**Before starting implementation, assess complexity:**

**Complex Task Detection → EnterPlanMode:**
If the task involves:
- Changes to more than 3-4 files
- Multiple valid implementation approaches
- New patterns or architectural decisions
- Significant refactoring

Then suggest entering plan mode:
```
AskUserQuestion:
  question: "This task appears complex ({reason}). Enter plan mode first?"
  header: "Approach"
  options:
    - "Yes, plan first"
      description: "Enter plan mode to design approach before implementing"
    - "No, proceed directly"
      description: "Start implementing without formal planning"
```

If user chooses to plan, use `EnterPlanMode` tool.

**Delegate Complex Subtasks → Task Tool:**
For complex analysis or exploration during implementation:
```
Task:
  subagent_type: Explore
  prompt: "Find all usages of {pattern} and how they integrate with {module}"
  description: "Explore {area} for implementation"
```

**Execute the actual work:**
- Use LSP for code navigation (goToDefinition, findReferences, documentSymbol)
- Create/modify files as needed
- Run relevant commands
- Test changes locally

#### 3.3 Complete Task

1. **Update TodoWrite:**
   - Mark task as `completed`
   - Move to next task

2. **Update Scratchpad:**
   - Check off completed item: `- [x] {task}`
   - Add notes to Work Log:
     ```markdown
     - Completed: {task description}
       - Notes: {any decisions or observations}
     ```

3. **Offer Commit** (under an authorized run: commit with commit-changes, no question):
   ```
   AskUserQuestion:
     question: "Task complete. Ready to commit?"
     header: "Commit"
     options:
       - "Yes, commit now"
         description: "Invoke commit-changes skill for this task"
       - "Continue to next task"
         description: "Skip commit, keep working"
       - "Review changes first"
         description: "Show me what changed before committing"
   ```

4. **If committing:** Invoke `commit-changes` skill
   ```
   Skill: commit-changes
   ```

5. **Progress Update:**
   ```
   ✓ {X} of {Y} tasks complete
   ```

#### 3.4 Handle Blockers

Under an authorized run: note the blocker, then escalate and stop (Authorized Path, step D).

If blocked during a task:

1. **Update Scratchpad:**
   - Add to Questions/Blockers section
   - Note what's blocking progress

2. **Ask User:**
   ```
   AskUserQuestion:
     question: "Encountered blocker: {description}. How to proceed?"
     options:
       - "Help me resolve it"
       - "Skip to next task"
       - "Pause work session"
       - "Add to blockers and continue"
   ```

### Phase 4: Continuous Sync

Throughout the session:

1. **Push Reminders** (not under an authorized run: `factory pr` pushes):
   - After every 2-3 commits, offer to push:
     ```
     📤 You have {N} unpushed commits. Push to remote?
     ```
   - Push as the agent, the way create-pr's Phase 6 step 1 does: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" --json push`. Only on `no_agent_token` or `not_github` (origin isn't on github.com) fall back to `git push -u origin {branch}`, saying in one line that the push is the operator's and why. On any other error, report it; never retry as the operator.

2. **Progress Persistence:**
   - Keep scratchpad updated with running notes
   - Work Log captures decisions made
   - Checklist reflects completion state

3. **Interruption Handling:**
   - If work is interrupted, save state:
     - Note current task in Work Log
     - Save any uncommitted progress notes
     - Can resume later with same skill

### Phase 5: Completion Check

When all Implementation Tasks are complete (under an authorized run, skip running the checks here: validate-work runs the project's `static` and `verify` in step B, and its report decides. Go on with the Authorized Path, step B):

1. **Quality Checks:**
   - Run through Quality Checks section of scratchpad
   - Execute linters/tests as applicable
   - Self-review for code quality

2. **Verify Acceptance Criteria:**
   - Review original acceptance criteria
   - Confirm all are met

3. **Update Scratchpad:**
   ```markdown
   ### {Date} - Session Complete
   - All implementation tasks complete
   - Quality checks: {passed/issues}
   - Ready for PR: {yes/no}
   ```

4. **Final TodoWrite:**
   - All tasks marked `completed`
   - Clear visual confirmation of completion

### Phase 6: Next Steps

Under an authorized run, the Authorized Path (steps B–E) replaces this phase. Otherwise present options:

```
✅ All tasks complete!

Options:
1. Create PR → Invoke create-pr skill
2. Archive scratchpad → Invoke archive-work skill
3. Continue in session → Keep working (add more tasks?)
4. End session → Save state and exit

Select option:
```

## Authorized Path

Only after Phase 0.5 matched. The approved plan and contract stand in for every confirmation; nothing here asks the operator a question. When something can't go on, the run is escalated and the operator is notified, and the session stops.

### A. Implement

1. **Resume** from the first unchecked task in the scratchpad, without asking. TodoWrite and the Work Log are kept as usual.
   **Back after a failed attempt** (`factory authorization` has a `fix`, from the fix loop or `factory continue`): the task list is the fix. Add a Work Log entry "Fix attempt {fix.attempt} ({fix.outcome})" listing each of `fix.blocking_findings` and, for an error, `fix.error` (its cause and reason); the report at `fix.report_path` has the details and logs. Fix exactly those (§6.2: the implementer works from the findings), commit with commit-changes, then validate (step B). A finding you can't fix inside the approved contract, such as one that would need a contract change or a change to the project's checks, test configuration or CI, is a blocker (step D).
2. **No plan-mode or approach questions** (3.2): the approved plan is the plan. Explore agents and LSP are fine.
3. **Builds and tests go through the runner**, so they wait their turn on the shared build lock:
   ```bash
   bash "$FACTORY" exec '{run_id}' -- {command}
   ```
   It exits with the command's status; its output is streamed and logged under the artifact dir. The `factory-exec-guard` hook refuses the project's `static` and `verify` commands run any other way, with the exact command to use instead. Diagnostic runs, such as a single test file or a check at the base commit, go through `exec` too.
4. **Commit each task** by invoking commit-changes (3.3), with no "Ready to commit?" question. commit-changes sees the same authorization and commits as the agent, without asking.
5. **Stay inside the contract.** Read it at `{artifact_dir}/contract.json`. Don't edit it, and don't edit the project's checks, test configuration or CI to make them pass: the runner flags policy and modified-assertion changes for the reviewer.
6. **A failing check is yours to fix** when your change caused it: that is implementing. When it fails for a reason the change didn't cause (it fails on the base commit too, or the environment can't run it) and fixing it would mean changing the checks, test configuration or CI, it is a blocker.
7. **A blocker** (3.4) you can't resolve from the plan, the contract and the code: commit the tasks already finished (so the tree is clean), don't start new ones, note the blocker under Questions/Blockers, then escalate and stop (step D).

### B. Validate

After the last task:
1. Make sure everything is committed: `git status --porcelain --untracked-files=all` lists nothing but working files excluded in `.git/info/exclude`. Commit what belongs to the work (commit-changes). Anything else is a blocker (step D).
2. Invoke validate-work. Route on its result:
   - `pass` or `pending_manual`: step C.
   - `fail` or `error`: the runner has already decided what follows (validate-work reports the run state and reason):
     - run `implementing`: the fix loop goes again. Ask `factory authorization` again and go back to step A with its `fix`. Each loop is a new attempt; the runner stops it at `max-attempts`, the deadline, or the same failure twice.
     - run `escalated`: the runner stopped it for a human (an environment error, the attempts used up, the deadline, a refused sign-off or unjustified assertion, or a stuck failure). Step D, with the report's blocking findings and the run's reason.
   - `blocked`: when it is `dirty_tree` caused by your own uncommitted work, commit it and invoke validate-work once more. Anything else: escalate (step D).
   - A runner crash inside validation is validate-work's to recover (it resumes and carries on); don't escalate for one. If the session itself was interrupted, re-entering do-work routes through Phase 0.5's `next` and continues.

### C. Open the PR

Invoke create-pr. It writes the title and description, and `factory pr` pushes the branch and opens the PR as the agent, with the validation report. On success, tick the scratchpad's Quality Checks and the acceptance criteria the report shows as demonstrated (manual ones stay open until recorded), update the Work Log and notify (step E) with the PR URL. Merging is the operator's: never merge. Advisory findings don't block: list them in the summary. Don't change code after validation to address them, since that needs a new attempt.

If `factory pr` fails, route on its code:
- **No JSON, or exit status 128 or more:** the runner died mid-step, possibly after GitHub created the PR. Run the same `factory pr` command again: its lookup finds that PR and records it (`action: recovered`). Then route on that result as here.
- **`gh_failed`, `push_failed`:** possibly transient, and GitHub may have acted before the failure. Run the same `factory pr` command once more: it finds a PR an earlier call created instead of opening a second one. If it fails again, notify (step E) and stop *without* escalating; the run stays `validated`, and create-pr can be run again later.
- **`no_agent_token`, `agent_env_permissions`, `gh_missing`, `lock_timeout`:** setup, not the run. Notify with the fix and stop without escalating.
- **Anything else** (`head_moved`, `pr_conflict`, `pr_not_open`, `contract_mismatch`, `not_validated`, `run_deadline`): escalate (step D).

### D. Escalate and stop

```bash
bash "$FACTORY" --json escalate '{run_id}' --reason '{one line: what stopped the run}'
```

A run the runner already escalated stays as it is (no-op). Record the reason in the Work Log, notify (step E) with the reason and the report path when there is one, and stop. Don't try to work around a refusal.

Escalate yourself, without retrying, when the next fix needs the operator rather than the implementer: it would change the contract (that needs `factory approve` again), the project's checks, test configuration or CI, or an assertion the reviewer won't accept as justified. The operator can take the run back later (Phase 0.5, **Escalated after a failed attempt**).

### E. Notify the operator

Send a push notification (PushNotification tool, when available) and end with the same summary as the final message:

```
🏭 {run_id}: {PR #{n} opened: {url} | escalated: {reason}}
   Outcome: {outcome}   Report: {report_path}   (leave out when there is no attempt yet)
   {pending manual checks, if any: each ID and how to record it (validate-work)}
```

## State Management

### TodoWrite ↔ Scratchpad Sync

| Action | TodoWrite | Scratchpad |
|--------|-----------|------------|
| Task starts | `in_progress` | Work Log entry |
| Task completes | `completed` | Checkbox checked, Work Log note |
| Task blocked | stays `in_progress` | Blockers section updated |
| Session ends | cleared | Work Log "session end" |
| Session resumes | rebuilt from scratchpad | Work Log "session resume" |

### Progress Recovery

If Claude Code restarts mid-session:
1. Re-read scratchpad
2. Rebuild TodoWrite from checklist state
3. Resume from last incomplete task

## Error Handling

### Scratchpad Not Found
```
❌ No scratchpad found for issue #{number}

   Would you like to:
   1. Run setup-work for this issue
   2. Specify a different issue number
   3. Create a new scratchpad manually
```

Under an authorized run, `factory authorization` has already matched the branch, and uncommitted changes from an earlier session are committed with commit-changes when they belong to the work (anything else is a blocker: step D). The questions below are for the interactive path.

### Wrong Branch
```
⚠️ Expected branch: {expected}
   Current branch: {current}

   Would you like to switch branches?
```

### Uncommitted Changes from Previous Session
```
⚠️ Found uncommitted changes from previous work.

   Options:
   1. Commit these changes now
   2. Stash and continue
   3. Review changes first
```

## Integration with Other Skills

**Invokes:**
- `commit-changes` skill - After completing tasks
- `validate-work` skill - Under an authorized run, after the last task
- `create-pr` skill - When all tasks complete (under an authorized run, after validation passes)
- `archive-work` skill - After PR created

**Calls:**
- `scripts/factory.sh` `authorization`, `agent`, `exec` and `escalate` (docs/FACTORY_CLI.md)

**Invoked by:**
- User directly via natural language
- After `setup-work` skill completes

**Reads from:**
- Scratchpad - Implementation plan
- Project CLAUDE.md - Conventions

## Best Practices

### ✅ DO:
- Keep TodoWrite in sync with scratchpad
- Add notes to Work Log for decisions
- Commit after each logical task
- Update blockers promptly
- Review progress periodically

### ❌ DON'T:
- Skip TodoWrite updates
- Let scratchpad get stale
- Batch too many changes before committing
- Ignore blockers
- Leave session without saving state

---

**Version:** 1.4.1
**Last Updated:** 2026-11-17
**Maintained By:** Escapement
**Changelog:**
- v1.4.1: A run escalated for a rejected manual procedure offers only abandon and start over: its instructions are in the approved contract, so no fix can help (#99)
- v1.4.0: The fix loop (#92): after a failed or errored attempt the run comes back to implementing with `fix` (its blocking findings and error), and do-work fixes, commits and validates again; an escalated run after a failed attempt offers "fix it and continue" (`factory continue`), "abandon" or "start over"
- v1.3.1: Push reminders push as the agent with `factory push` (#80)
- v1.3.0: Authorized path: `next` `validate`; a crash inside validation is validate-work's to recover; a `factory pr` that dies is run again and recovers the PR (#65)
- v1.2.0: Authorized path: under a matching active factory authorization, implement with builds and tests through `factory exec`, commit, validate (validate-work) and open the PR (create-pr) without questions; escalate and notify when it can't go on (#64)
- v1.1.0: Added EnterPlanMode for complex tasks, Task delegation, LSP navigation
- v1.0.0: Initial conversion from commands/start-work.md
