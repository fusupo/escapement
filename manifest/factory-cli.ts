import type { Database } from "better-sqlite3";
import { initManifest, resolveDbPath } from "./init.ts";
import { projectContext, resolveWorktree, excludePatterns, mainRepoRoot, repoName, git } from "./factory/context.ts";
import { agentIdentity, pushAsAgent, TOKEN_VAR, NAME_VAR, EMAIL_VAR } from "./factory/github.ts";
import { matchAuthorization, noMatch, type AuthorizationMatch } from "./factory/authorization.ts";
import { startRun, approveRun, revokeRun, escalateRun, runStatus, listRuns } from "./factory/runs.ts";
import { continueRun } from "./factory/fixloop.ts";
import { getRun } from "./factory/state.ts";
import { loadSettings, SETTING_DEFAULTS, type FactorySettings } from "./factory/settings.ts";
import { execCommand, execExitCode } from "./factory/exec.ts";
import { resumeRun } from "./factory/resume.ts";
import { validateRun } from "./factory/validate.ts";
import { reviewInput, recordReview } from "./factory/review.ts";
import { openPr } from "./factory/pr.ts";
import { recordManual, type RecordedView } from "./factory/manual.ts";
import { archiveRun } from "./factory/archive.ts";
import { syncGuard } from "./factory/guard.ts";
import { currentOwner } from "./factory/owner.ts";
import { parseFaultSpec, FAULT_ENV } from "./factory/fault.ts";
import { FactoryError, parseDuration } from "./factory/util.ts";
import { checkReadiness, readinessText } from "./factory/readiness.ts";
import { SCHEMA_NAMES, schemaPath, isSchemaName } from "./factory/schemas.ts";
import { PROMPT_NAMES, promptPath, isPromptName } from "./factory/prompts.ts";
import { checkCritique, recordCritique } from "./factory/critique.ts";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * The factory runner CLI (docs/FACTORY_CLI.md). Hosts call it through
 * scripts/factory.sh. Every command accepts --json and then prints exactly
 * one JSON object on stdout:
 *
 *   {"ok": true,  "command": "...", "result": {...}}
 *   {"ok": false, "command": "...", "error": {"code": "...", "kind": "error"|"blocked", "message": "..."}}
 *
 * An error may also carry `detail`, facts a caller routes on (such as
 * not_github's `cause`); it is present only when the error sets it.
 *
 * Exit status: 0 ok, 1 error, 2 blocked. `exec` exits with the command's
 * own status, or 124 when the runner killed it. `validate` exits 0 when
 * it recorded an attempt, and `record-review` when it recorded a verdict,
 * whatever the outcome: route on the JSON.
 */

const USAGE = `Usage: factory [options] <command> [args]

Commands:
  start <work-item>             Create a run (state planned) for a work item:
                                #42, owner/repo#42 or any external id
  approve <run_id> --contract <file>
                                Record the contract and authorize the run
  exec <run_id> -- <cmd> [args...]
                                Run a build/test command under the locks
  validate <run_id>             Run the deterministic checks for a new attempt and
                                write its draft report (static, then evidence)
  review-input <run_id> <attempt>
                                Write the reviewer's bundle for an attempt
                                awaiting review (--issue-file: the issue text)
  record-review <run_id> <attempt> <file>
                                Check a reviewer verdict (- reads stdin) and
                                finalize the attempt's report
  record-critique <run_id> <file>
                                Attach the final plan critique (- reads stdin;
                                every finding with its disposition) to the run:
                                critique.json and one critique_finding event per
                                finding
  record-manual <run_id> <evidence_id> pass|fail --note <text>
                [--assisted [--attachment <file>]...]
                                Record a human's outcome for manual evidence the
                                report left pending; all pass (or any fail)
                                writes the next report revision
  pr <run_id> [--title <t>] [--body-file <f>]
                                Push the branch and open or update the run's PR
                                as the agent (idempotent; needs a validated run
                                and ESCAPEMENT_AGENT_GH_TOKEN)
  archive <run_id> --path <dir> [--close] [--abandon]
                                Record where the run's artifacts were archived;
                                --close closes the run (merged or abandoned,
                                from its PR), --abandon without asking GitHub
  status [run_id]               List open runs (--all: include closed), or show one
  resume <run_id>               Reconcile an interrupted run
  revoke <run_id>               End the run's active authorization
  escalate <run_id> --reason <text>
                                Stop the run to wait on a human (no-op when it
                                is already blocked or escalated)
  continue <run_id> --reason <text> [--trigger <t>] [--run-budget <dur>]
                                Take an escalated run whose latest attempt failed
                                or errored, or a run whose PR is open, back to
                                implementing, under the same contract and
                                authorization (the attempt budget is not reset;
                                a run with a PR gets a new deadline)
  check [--contract <file>]     Readiness: is the contract valid and runnable in
                                this project? Prints ready or needs_human with
                                questions (no run needed). Without --contract,
                                checks only the project's settings
  check-critique <file> [--final]
                                Check a plan critique (- reads stdin) against
                                critique.schema.json and its rules (no run
                                needed); --final: every finding needs a
                                disposition
  schema [name]                 Path of a published JSON Schema (contract, report,
                                verdict, readiness, critique); --print for its content
  prompt [name]                 Path of an agent prompt the factory ships
                                (reviewer, critic); --print for its content
  exclude <pattern>...          Add .gitignore-style patterns for the host's
                                working files to the repository's
                                .git/info/exclude (no run needed)
  agent                         The AI agent's commit identity (name, email),
                                from ${NAME_VAR}/${EMAIL_VAR}, else
                                the account of ${TOKEN_VAR}
  push                          Push the current branch as the agent, with no
                                run (plain skills); never forced, never the
                                base branch, main or master
  authorization                 Does this worktree have a run whose active
                                authorization lets skills act without asking?
                                Prints matched or the reasons it isn't (exit 0
                                either way; never creates the database)

Options:
  --json                Print one JSON object (see docs/FACTORY_CLI.md)
  --data-dir <path>     Use {path}/manifest.db instead of the shared manifest
  --project-root <path> start, check, exclude, push, authorization: the worktree
                        (default: git toplevel of the cwd)
  --artifact-dir <path> Put run artifacts in {path}/{run_id}/
  --issue <n>           start: issue number, when the work item isn't #N
  --manifest-id <id>    start: manifest work item, for reference only
  --target-ref <ref>    start: branch the work targets (default develop or main)
  --work-type <type>    start: e.g. feature, bug
  --contract <file>     approve, check: the contract (check: optional)
  --run-budget <dur>    approve: run deadline after first approval
                        (default: run-budget setting, else ${SETTING_DEFAULTS["run-budget"]});
                        continue, for a run with a PR: the new deadline's
                        budget (default: the one fixed at approval)
  --trigger <t>         continue, for a pr_open run only: review_finding or
                        operator_request (default); other runs' is derived
  --timeout <dur>       exec, validate: timeout per command
                        (default: command-timeout setting, else ${SETTING_DEFAULTS["command-timeout"]})
  --issue-file <file>   review-input: the issue text to put in the bundle
  --lock-timeout <dur>  exec, validate, review-input, record-review, resume, pr,
                        record-manual, archive:
                        how long to wait for locks
                        (default: lock-timeout setting, else ${SETTING_DEFAULTS["lock-timeout"]})
  --reason <text>       escalate: why the run needs a human; continue: what
                        the operator decided
  --note <text>         record-manual: what was checked and seen
  --recorder <name>     record-manual: who checked (default: the OS user)
  --assisted            record-manual: the agent carried out the check's steps
                        and the human decided from its observations
  --attachment <file>   record-manual, with --assisted: one of the agent's
                        observations or screenshots, under
                        {artifact_dir}/manual/{evidence_id}/ (repeatable, max 20)
  --title <text>        pr: the PR title (needed to create it)
  --body-file <file>    pr: the host's PR description; the runner adds its
                        report section (on update, only the section changes)
  --path <dir>          archive: where the host archived the run's artifacts
  --close               archive: close the run, from its PR's state
  --abandon             archive: close the run as abandoned
  --all                 status: include closed runs
  --print               schema, prompt: print the content instead of the path
  --final               check-critique: the record after the critique round

Durations: 30s, 15m, 2h, 1d. Settings are read from the run's worktree
CLAUDE.md, "## Escapement Settings" (docs/FACTORY_CLI.md).`;

const VALUE_FLAGS = new Set([
  "--data-dir",
  "--project-root",
  "--artifact-dir",
  "--issue",
  "--manifest-id",
  "--target-ref",
  "--work-type",
  "--contract",
  "--run-budget",
  "--timeout",
  "--lock-timeout",
  "--issue-file",
  "--reason",
  "--trigger",
  "--title",
  "--body-file",
  "--note",
  "--recorder",
  "--path",
]);
/** Value flags that may be given more than once; every value is kept, in order. */
const LIST_FLAGS = new Set(["--attachment"]);
const BOOL_FLAGS = new Set(["--json", "--all", "--print", "--close", "--abandon", "--final", "--assisted", "--help", "-h"]);

type Parsed = { flags: Map<string, string | true>; lists: Map<string, string[]>; positional: string[]; rest: string[] };

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const positional: string[] = [];
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest = argv.slice(i + 1);
      break;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.has(name) || LIST_FLAGS.has(name)) {
      const value = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new FactoryError("usage", `${name} needs a value`);
      if (LIST_FLAGS.has(name)) lists.set(name, [...(lists.get(name) ?? []), value]);
      else flags.set(name, value);
    } else if (BOOL_FLAGS.has(a)) {
      flags.set(a, true);
    } else if (a.startsWith("-") && a !== "-") {
      throw new FactoryError("usage", `unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, lists, positional, rest };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

/**
 * A duration flag, or else the run's setting. Settings are read from the
 * run's worktree only when a flag is missing, so an invalid CLAUDE.md
 * doesn't stop a command whose limits are all given.
 */
function duration(
  db: Database,
  p: Parsed,
  name: string,
  runId: string,
  setting: (s: FactorySettings) => number,
): number {
  const flag = str(p, name);
  if (flag !== undefined) return parseDuration(flag);
  return setting(loadSettings(getRun(db, runId).worktree_path).settings);
}

function attemptArg(value: string | undefined): number {
  const text = need(value, "attempt");
  if (!/^[1-9]\d*$/.test(text)) throw new FactoryError("usage", `attempt must be a positive number, not ${text}`);
  return Number(text);
}

/** A file's text, or stdin for `-`. */
function readInput(file: string, what: string): string {
  try {
    return file === "-" ? readFileSync(0, "utf-8") : readFileSync(resolve(file), "utf-8");
  } catch (err) {
    throw new FactoryError("usage", `cannot read ${what} ${file}: ${(err as Error).message}`);
  }
}

/** One recorded manual outcome, for record-manual's and status's text. */
function manualLine(m: RecordedView): string {
  const assisted = m.assisted ? `, agent-assisted, ${m.attachments.length} attachment(s)${m.attachments.length ? `: ${m.attachments.join(", ")}` : ""}` : "";
  return `${m.evidence_id} ${m.outcome} by ${m.recorder}${assisted}`;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new FactoryError("usage", `missing ${what}`);
  return value;
}

type Outcome = { result: unknown; text: string; exitCode?: number };

/** Commands that can change a run's state or authorization: the exec guard's marker is re-synced after them. */
const GUARD_SYNC_COMMANDS = new Set([
  "approve",
  "revoke",
  "escalate",
  "continue",
  "exec",
  "validate",
  "record-review",
  "record-manual",
  "pr",
  "archive",
  "resume",
]);

/** Every command that uses the manifest database. */
const KNOWN_DB_COMMANDS = new Set([
  "start",
  "record-critique",
  "approve",
  "exec",
  "validate",
  "review-input",
  "record-review",
  "status",
  "resume",
  "revoke",
  "escalate",
  "continue",
  "authorization",
  "pr",
  "record-manual",
  "archive",
]);

/** Commands that don't touch the manifest database, so hosts can run them anywhere. */
const NO_DB_COMMANDS = new Set(["check", "check-critique", "schema", "prompt", "exclude", "agent", "push"]);

function dispatchNoDb(command: string, p: Parsed): Outcome {
  const [arg] = p.positional;
  switch (command) {
    case "check": {
      const contract = str(p, "--contract");
      const file = contract === undefined ? "" : resolve(contract);
      let text: string | null | undefined = undefined;
      if (contract !== undefined) {
        try {
          text = readFileSync(file, "utf-8");
        } catch {
          text = null;
        }
      }
      // Readiness needs the worktree, not a branch: a detached HEAD (a fresh
      // `git worktree add --detach`) is a valid place to check settings (#65).
      const r = checkReadiness({ contractText: text, source: file, projectDir: resolveWorktree(str(p, "--project-root")) });
      return { result: r, text: readinessText(r) };
    }
    case "check-critique": {
      const file = need(arg, "critique file (or - for stdin)");
      const r = checkCritique(readInput(file, "critique"), { final: p.flags.has("--final"), source: file === "-" ? "(stdin)" : file });
      const f = r.findings;
      const lines = [
        `valid${r.final ? " (final)" : ""}: ${r.verdict}, ${f.blocking} blocking, ${f.major} major, ${f.minor} minor finding(s)`,
        ...(r.concerns.length ? [`  concerns: ${r.concerns.join(", ")}`] : []),
        ...(r.tier_raise ? [`  tier raise: ${r.tier_raise.to} (${r.tier_raise.reason})`] : []),
        ...(r.dispositions ? [`  dispositions: ${r.dispositions}${r.unresolved.length ? `, decided by the operator: ${r.unresolved.join(", ")}` : ""}`] : []),
      ];
      return { result: r, text: lines.join("\n") };
    }
    case "exclude": {
      const r = excludePatterns(resolveWorktree(str(p, "--project-root")), p.positional);
      const lines = [
        ...r.added.map((x) => `added   ${x}`),
        ...r.present.map((x) => `present ${x}`),
        `  in ${r.path}`,
      ];
      return { result: r, text: lines.join("\n") };
    }
    case "agent": {
      const a = agentIdentity();
      return { result: a, text: `${a.name} <${a.email}>${a.login ? `  (GitHub: ${a.login})` : ""}` };
    }
    case "push": {
      if (p.positional.length > 0) throw new FactoryError("usage", "push takes no arguments: it pushes the current branch");
      const r = pushAsAgent({ worktree: resolveWorktree(str(p, "--project-root")) });
      return { result: r, text: `pushed ${r.branch} (${r.sha.slice(0, 12)}) to ${r.remote} as the agent` };
    }
    case "schema": {
      if (arg === undefined) {
        const schemas = SCHEMA_NAMES.map((name) => ({ name, path: schemaPath(name) }));
        return { result: { schemas }, text: schemas.map((x) => `${x.name.padEnd(10)} ${x.path}`).join("\n") };
      }
      if (!isSchemaName(arg)) throw new FactoryError("usage", `unknown schema ${arg} (use ${SCHEMA_NAMES.join(", ")})`);
      const path = schemaPath(arg);
      if (p.flags.has("--print")) {
        const content = readFileSync(path, "utf-8");
        return { result: { name: arg, path, schema: JSON.parse(content) }, text: content.trimEnd() };
      }
      return { result: { name: arg, path }, text: path };
    }
    case "prompt": {
      if (arg === undefined) {
        const prompts = PROMPT_NAMES.map((name) => ({ name, path: promptPath(name) }));
        return { result: { prompts }, text: prompts.map((x) => `${x.name.padEnd(10)} ${x.path}`).join("\n") };
      }
      if (!isPromptName(arg)) throw new FactoryError("usage", `unknown prompt ${arg} (use ${PROMPT_NAMES.join(", ")})`);
      const path = promptPath(arg);
      if (p.flags.has("--print")) {
        const content = readFileSync(path, "utf-8");
        return { result: { name: arg, path, content }, text: content.trimEnd() };
      }
      return { result: { name: arg, path }, text: path };
    }
    default:
      throw new FactoryError("usage", `unknown command ${command}`);
  }
}

/**
 * The worktree, repo and branch `authorization` compares a run against.
 * Not being in a repository, or on a branch, is an answer, not an error:
 * skills call this everywhere and fall back to asking.
 */
function authorizationFor(db: Database | null, projectRoot: string | undefined): AuthorizationMatch {
  let worktreePath: string;
  try {
    worktreePath = resolveWorktree(projectRoot);
  } catch (err) {
    if (err instanceof FactoryError && err.code === "not_a_repo") return noMatch("not_a_repo");
    throw err;
  }
  let branch = "";
  try {
    branch = git(["branch", "--show-current"], worktreePath);
  } catch {
    // treated as detached below
  }
  if (!branch) return noMatch("detached_head");
  if (!db) return noMatch("no_database");
  return matchAuthorization(db, { worktreePath, repo: repoName(mainRepoRoot(worktreePath)), branch });
}

function describeMatch(r: AuthorizationMatch): string {
  if (!r.matched) return `not matched: ${r.reasons.join(", ")}${r.run_id ? `\n  run: ${r.run_id} (${r.state})` : ""}`;
  return [
    `matched: ${r.run_id} (${r.state}), next: ${r.next}`,
    `  branch:    ${r.branch} → ${r.target_ref}`,
    `  contract:  ${r.contract_digest}`,
    `  authorizes: ${r.authorizes.join(", ")}`,
    `  deadline:  ${r.deadline_at ?? "-"}`,
    ...(r.pr_number !== null ? [`  pr:        #${r.pr_number}`] : []),
    ...(r.fix
      ? [
          `  fix:       attempt ${r.fix.attempt} ${r.fix.outcome}${r.fix.error ? ` (${r.fix.error.cause}: ${r.fix.error.reason})` : ""}`,
          ...(r.fix.trigger ? [`    re-entry: ${r.fix.trigger}: ${r.fix.reason}`] : []),
          ...r.fix.blocking_findings.map((f) => `    - ${f.id}: ${f.detail}`),
          ...(r.fix.report_path ? [`    report: ${r.fix.report_path}`] : []),
        ]
      : []),
    ...(r.reentry ? [`  re-entered: ${r.reentry.count}x, latest ${r.reentry.trigger} after attempt ${r.reentry.attempt}`] : []),
  ].join("\n");
}

async function dispatch(db: Database, command: string, p: Parsed, json: boolean): Promise<Outcome> {
  const owner = currentOwner(`factory ${command}`);
  const [arg] = p.positional;
  switch (command) {
    case "start": {
      const issue = str(p, "--issue");
      if (issue !== undefined && !/^\d+$/.test(issue)) throw new FactoryError("usage", "--issue must be a number");
      const run = startRun(db, {
        workItem: need(arg, "work item (e.g. #42)"),
        ctx: projectContext(str(p, "--project-root")),
        artifactDir: str(p, "--artifact-dir"),
        issue: issue === undefined ? undefined : Number(issue),
        manifestId: str(p, "--manifest-id"),
        targetRef: str(p, "--target-ref"),
        workType: str(p, "--work-type"),
      });
      return {
        result: run,
        text: `Started ${run.run_id} (planned)\n  worktree:  ${run.worktree_path}\n  branch:    ${run.branch} → ${run.target_ref}\n  artifacts: ${run.artifact_dir}`,
      };
    }
    case "approve": {
      const runId = need(arg, "run_id");
      const contractFile = need(str(p, "--contract"), "--contract <file>");
      const r = approveRun(db, runId, {
        contractFile,
        budgetMs: duration(db, p, "--run-budget", runId, (s) => s.runBudgetMs),
        owner,
      });
      const what = !r.changed ? "already approved with this contract" : r.superseded ? "re-approved (previous contract superseded)" : "approved";
      return {
        result: { ...r, authorization: { ...r.authorization, authorizes: JSON.parse(r.authorization.authorizes_json) } },
        text: `${r.run.run_id} ${what}\n  state:    ${r.run.state}\n  contract: ${r.authorization.contract_digest}\n  deadline: ${r.run.deadline_at}`,
      };
    }
    case "exec": {
      if (p.rest.length === 0) throw new FactoryError("usage", "exec needs a command: factory exec <run_id> -- <cmd> [args...]");
      const runId = need(arg, "run_id");
      const r = await execCommand(db, runId, p.rest, {
        owner,
        timeoutMs: duration(db, p, "--timeout", runId, (s) => s.commandTimeoutMs),
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
        echo: !json,
      });
      const why = r.reason ? ` (${r.reason})` : "";
      return {
        result: r,
        text: `factory: ${r.outcome}${why}, exit ${r.exit_code ?? "-"}, ${(r.duration_ms / 1000).toFixed(1)}s, log ${r.log_path}`,
        exitCode: execExitCode(r),
      };
    }
    case "validate": {
      const runId = need(arg, "run_id");
      const timeout = str(p, "--timeout");
      const r = await validateRun(db, runId, {
        owner,
        timeoutMs: timeout === undefined ? undefined : parseDuration(timeout),
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
        echo: !json,
      });
      const what = r.outcome === null ? "checks passed, awaiting review" : `${r.outcome} (${r.failed_phase ?? "post-check"})`;
      return {
        result: r,
        text: `${r.run_id} attempt ${r.attempt}: ${what}\n  run:    ${r.run_state}\n  tier:   ${r.tier.actual}${r.tier.reasons.length ? ` (${r.tier.reasons.join("; ")})` : ""}\n  report: ${r.report_path}`,
      };
    }
    case "review-input": {
      const runId = need(arg, "run_id");
      const attempt = attemptArg(p.positional[1]);
      const issueFile = str(p, "--issue-file");
      const r = await reviewInput(db, runId, attempt, {
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
        issueFile: issueFile === undefined ? undefined : resolve(issueFile),
        dataDir: dirname(resolveDbPath({ dataDir: str(p, "--data-dir") })),
      });
      const n = r.required;
      return {
        result: r,
        text: `${r.bundle_path}\n  ${runId} attempt ${attempt}: ${n.evidence} evidence judgment(s), ${n.sensitive_paths} sign-off(s), ${n.modified_assertions} justification(s) required\n  source: ${r.source_digest}${r.reused_snapshot ? " (unchanged snapshot kept)" : ""}`,
      };
    }
    case "record-review": {
      const runId = need(arg, "run_id");
      const attempt = attemptArg(p.positional[1]);
      const file = need(p.positional[2], "verdict file (or - for stdin)");
      let text: string;
      try {
        text = file === "-" ? readFileSync(0, "utf-8") : readFileSync(resolve(file), "utf-8");
      } catch (err) {
        throw new FactoryError("usage", `cannot read verdict ${file}: ${(err as Error).message}`);
      }
      const r = await recordReview(db, runId, attempt, text, {
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
        source: file === "-" ? "(stdin)" : file,
      });
      const how = r.noop ? " (already recorded)" : r.refinalized ? " (finalization completed)" : "";
      return {
        result: r,
        text: `${runId} attempt ${attempt}: ${r.outcome}${how}\n  run:     ${r.run_state}\n  report:  ${r.report_path}\n  verdict: ${r.verdict_path}`,
      };
    }
    case "record-critique": {
      const runId = need(arg, "run_id");
      const file = need(p.positional[1], "critique file (or - for stdin)");
      const r = recordCritique(db, runId, readInput(file, "critique"), { owner, source: file === "-" ? "(stdin)" : file });
      return {
        result: r,
        text: `${runId}: critique ${r.verdict}${r.noop ? " (already recorded)" : ""}, ${r.findings} finding(s): ${r.accepted} accepted, ${r.rejected} rejected${r.unresolved.length ? `; decided by the operator: ${r.unresolved.join(", ")}` : ""}\n  ${r.path}`,
      };
    }
    case "record-manual": {
      const runId = need(arg, "run_id");
      const r = await recordManual(db, runId, need(p.positional[1], "evidence_id"), need(p.positional[2], "pass or fail"), {
        note: need(str(p, "--note"), "--note <text>"),
        recorder: str(p, "--recorder"),
        assisted: p.flags.has("--assisted"),
        attachments: p.lists.get("--attachment") ?? [],
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
      });
      const state = r.resolved
        ? `resolved: ${r.resolved} (report revision ${r.report_revision})`
        : `${r.pending.length} manual check(s) still pending: ${r.pending.join(", ")}`;
      const recorded = r.recorded.map((m) => `\n  recorded: ${manualLine(m)}`).join("");
      return {
        result: r,
        text: `${runId} ${r.evidence_id}: ${r.outcome}${r.assisted ? " (agent-assisted)" : ""}${r.noop ? " (already recorded)" : ""}\n  ${state}${recorded}\n  run:    ${r.run_state}\n  report: ${r.report_path}${r.refresh_pr ? `\n  PR #${r.pr_number} shows the old report: run factory pr '${runId}'` : ""}`,
      };
    }
    case "archive": {
      const runId = need(arg, "run_id");
      const r = await archiveRun(db, runId, {
        path: need(str(p, "--path"), "--path <dir>"),
        close: p.flags.has("--close"),
        abandon: p.flags.has("--abandon"),
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
      });
      return {
        result: r,
        text: `${runId}: archived at ${r.archive_path}${r.changed ? "" : " (unchanged)"}\n  run: ${r.state}${r.closed ? ` (${r.closed})` : ""}${r.operator_action ? `\n  operator action: ${r.operator_action}` : ""}${r.merge_sha ? `\n  merge: ${r.merge_sha}` : ""}`,
      };
    }
    case "pr": {
      const runId = need(arg, "run_id");
      const bodyFile = str(p, "--body-file");
      let narrative: string | undefined;
      if (bodyFile !== undefined) {
        try {
          narrative = readFileSync(resolve(bodyFile), "utf-8");
        } catch (err) {
          throw new FactoryError("usage", `cannot read --body-file ${bodyFile}: ${(err as Error).message}`);
        }
      }
      const r = await openPr(db, runId, {
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
        title: str(p, "--title"),
        narrative,
      });
      return {
        result: r,
        text:
          `${runId}: PR #${r.pr_number} ${r.action} (${r.outcome}, attempt ${r.attempt})\n  ${r.url}\n  run:  ${r.state}\n  body: ${r.body_path}\n` +
          `  gate: ${r.gate.recommendation} (${r.gate.mode}; the merge is yours)${r.gate.reasons.map((x) => `\n    - ${x}`).join("")}`,
      };
    }
    case "status": {
      if (arg) {
        const s = runStatus(db, arg);
        const lines = [
          `${s.run.run_id}: ${s.run.state}${s.run.state_reason ? ` (${s.run.state_reason})` : ""}`,
          `  work item: ${s.run.work_item}   repo: ${s.run.repo}`,
          `  worktree:  ${s.run.worktree_path}`,
          `  branch:    ${s.run.branch} → ${s.run.target_ref}`,
          `  artifacts: ${s.run.artifact_dir}`,
          `  deadline:  ${s.run.deadline_at ?? "-"}${s.deadline_passed ? " (passed)" : ""}`,
          `  authorization: ${s.authorization ? `active, ${s.authorization.contract_digest}` : "none active"}`,
          `  attempts:  ${s.attempts.length ? s.attempts.map((a) => `${a.attempt}:${a.status}${a.outcome ? `/${a.outcome}` : ""}`).join(" ") : "none"}`,
          ...(s.manual
            ? [
                ...s.manual.recorded.map((m) => `  manual:    ${manualLine(m)}`),
                ...s.manual.pending.map((id) => `  manual:    ${id} awaiting a human`),
              ]
            : []),
          ...s.locks.map((l) => `  lock ${l.name}: pid ${l.holder.pid} (${l.holder.command})${l.alive ? "" : " [dead]"}`),
        ];
        return { result: s, text: lines.join("\n") };
      }
      const runs = listRuns(db, { all: p.flags.has("--all") });
      const text = runs.length
        ? runs.map((r) => `${r.run_id.padEnd(28)} ${r.state.padEnd(13)} ${r.branch}  ${r.worktree_path}`).join("\n")
        : "No open runs.";
      return { result: { runs }, text };
    }
    case "resume": {
      const runId = need(arg, "run_id");
      const r = await resumeRun(db, runId, {
        owner,
        lockWaitMs: duration(db, p, "--lock-timeout", runId, (s) => s.lockTimeoutMs),
      });
      const lines = [
        `${r.run.run_id}: ${r.run.state}${r.deadline_passed ? " (deadline passed: reconciled only)" : ""}`,
        ...(r.actions.length ? r.actions.map((a) => `  attempt ${a.attempt} (${a.found}): ${a.action}${a.detail ? ` — ${a.detail}` : ""}`) : ["  nothing to reconcile"]),
        ...r.released_locks.map((l) => `  released stale lock ${l}`),
        ...r.killed_groups.map((g) => `  killed process group ${g}, left running by a crashed check`),
      ];
      return { result: r, text: lines.join("\n") };
    }
    case "authorization": {
      const r = authorizationFor(db, str(p, "--project-root"));
      return { result: r, text: describeMatch(r) };
    }
    case "escalate": {
      const runId = need(arg, "run_id");
      const r = escalateRun(db, runId, { reason: need(str(p, "--reason"), "--reason <text>"), owner });
      return {
        result: r,
        text: r.changed ? `${runId}: escalated (${r.run.state_reason})` : `${runId}: already ${r.run.state}${r.run.state_reason ? ` (${r.run.state_reason})` : ""}; nothing changed`,
      };
    }
    case "continue": {
      const runId = need(arg, "run_id");
      const budget = str(p, "--run-budget");
      const r = continueRun(db, runId, {
        reason: need(str(p, "--reason"), "--reason <text>"),
        owner,
        trigger: str(p, "--trigger"),
        budgetMs: budget === undefined ? undefined : parseDuration(budget),
      });
      const err = r.error ? `, ${r.error.cause}: ${r.error.reason}` : "";
      const back = r.reentry ? `\n  re-entry: ${r.reentry.trigger}, PR #${r.reentry.pr_number} (deadline was ${r.reentry.previous_deadline ?? "-"})` : "";
      return {
        result: r,
        text: `${runId}: ${r.changed ? "back to implementing" : "already implementing"} after attempt ${r.attempt} (${r.outcome}${err})${back}\n  attempts: ${r.attempts_used} of ${r.max_attempts} used\n  deadline: ${r.run.deadline_at ?? "-"}`,
      };
    }
    case "revoke": {
      const a = revokeRun(db, need(arg, "run_id"));
      return { result: { authorization: a }, text: `${a.run_id}: authorization ${a.contract_digest} revoked` };
    }
    default:
      throw new FactoryError("usage", `unknown command ${command}`);
  }
}

/** A command other than start when the manifest database doesn't exist yet. */
function withoutDatabase(command: string, p: Parsed): Outcome {
  const where = resolveDbPath({ dataDir: str(p, "--data-dir") });
  if (command === "authorization") {
    const r = authorizationFor(null, str(p, "--project-root"));
    return { result: r, text: describeMatch(r) };
  }
  if (command === "status" && p.positional.length === 0) return { result: { runs: [] }, text: "No open runs." };
  if (!KNOWN_DB_COMMANDS.has(command)) throw new FactoryError("usage", `unknown command ${command}`);
  const runId = p.positional[0];
  if (!runId) throw new FactoryError("usage", "missing run_id");
  throw new FactoryError("no_such_run", `no run ${runId} (no factory database at ${where})`);
}

async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  const sep = argv.indexOf("--");
  const jsonRequested = (sep === -1 ? argv : argv.slice(0, sep)).includes("--json");
  let command = "";
  const fail = (err: unknown): number => {
    const fe =
      err instanceof FactoryError ? err : new FactoryError("internal", err instanceof Error ? err.message : String(err));
    if (jsonRequested) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          command,
          error: { code: fe.code, kind: fe.kind, message: fe.message, ...(fe.detail ? { detail: fe.detail } : {}) },
        }) + "\n",
      );
    } else {
      console.error(`factory: ${fe.message}`);
      if (fe.code === "usage") console.error(`\n${USAGE}`);
    }
    return fe.kind === "blocked" ? 2 : 1;
  };

  try {
    parsed = parseArgs(argv);
    // A mistyped fault spec must fail loudly up front, not mid-command.
    if (process.env[FAULT_ENV]) parseFaultSpec(process.env[FAULT_ENV]!);
  } catch (err) {
    if (err instanceof Error && !(err instanceof FactoryError)) err = new FactoryError("usage", err.message);
    return fail(err);
  }
  command = parsed.positional.shift() ?? "";
  if (!command || parsed.flags.has("--help") || parsed.flags.has("-h")) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  let db: Database | undefined;
  try {
    let out: Outcome;
    if (NO_DB_COMMANDS.has(command)) {
      out = dispatchNoDb(command, parsed);
    } else if (command !== "start" && !existsSync(resolveDbPath({ dataDir: str(parsed, "--data-dir") }))) {
      // Opening the manifest would create it. Only start creates runs, so
      // without a database there is no run: answer that, and create nothing.
      out = withoutDatabase(command, parsed);
    } else {
      db = initManifest({ dataDir: str(parsed, "--data-dir") });
      db.pragma("busy_timeout = 10000");
      out = await dispatch(db, command, parsed, jsonRequested);
    }
    if (jsonRequested) {
      process.stdout.write(JSON.stringify({ ok: true, command, result: out.result }) + "\n");
    } else {
      // exec's and validate's command output was streamed; their summary goes to stderr.
      (command === "exec" || command === "validate" ? console.error : console.log)(out.text);
    }
    return out.exitCode ?? 0;
  } catch (err) {
    return fail(err);
  } finally {
    // Also after a failure: a blocked command may have escalated the run.
    const runId = parsed.positional[0];
    if (db && runId && GUARD_SYNC_COMMANDS.has(command)) {
      try {
        syncGuard(db, runId);
      } catch {
        // The marker is advisory; resume and the next command re-sync it.
      }
    }
    db?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
