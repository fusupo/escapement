import type { Database } from "better-sqlite3";
import { initManifest } from "./init.ts";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun, revokeRun, runStatus, listRuns, DEFAULTS } from "./factory/runs.ts";
import { execCommand, execExitCode } from "./factory/exec.ts";
import { resumeRun } from "./factory/resume.ts";
import { currentOwner } from "./factory/owner.ts";
import { FactoryError, parseDuration } from "./factory/util.ts";

/**
 * The factory runner CLI (docs/FACTORY_CLI.md). Hosts call it through
 * scripts/factory.sh. Every command accepts --json and then prints exactly
 * one JSON object on stdout:
 *
 *   {"ok": true,  "command": "...", "result": {...}}
 *   {"ok": false, "command": "...", "error": {"code": "...", "kind": "error"|"blocked", "message": "..."}}
 *
 * Exit status: 0 ok, 1 error, 2 blocked. `exec` exits with the command's
 * own status, or 124 when the runner killed it.
 */

const USAGE = `Usage: factory [options] <command> [args]

Commands:
  start <work-item>             Create a run (state planned) for a work item:
                                #42, owner/repo#42 or any external id
  approve <run_id> --contract <file>
                                Record the contract and authorize the run
  exec <run_id> -- <cmd> [args...]
                                Run a build/test command under the locks
  status [run_id]               List open runs (--all: include closed), or show one
  resume <run_id>               Reconcile an interrupted run
  revoke <run_id>               End the run's active authorization

Options:
  --json                Print one JSON object (see docs/FACTORY_CLI.md)
  --data-dir <path>     Use {path}/manifest.db instead of the shared manifest
  --project-root <path> Worktree to run in (default: git toplevel of the cwd)
  --artifact-dir <path> Put run artifacts in {path}/{run_id}/
  --issue <n>           start: issue number, when the work item isn't #N
  --manifest-id <id>    start: manifest work item, for reference only
  --target-ref <ref>    start: branch the work targets (default develop or main)
  --work-type <type>    start: e.g. feature, bug
  --contract <file>     approve: the contract to approve
  --run-budget <dur>    approve: run deadline after first approval (default ${DEFAULTS.runBudget})
  --timeout <dur>       exec: command timeout (default ${DEFAULTS.commandTimeout})
  --lock-timeout <dur>  exec, resume: how long to wait for locks (default ${DEFAULTS.lockTimeout})
  --all                 status: include closed runs

Durations: 30s, 15m, 2h, 1d.`;

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
]);
const BOOL_FLAGS = new Set(["--json", "--all", "--help", "-h"]);

type Parsed = { flags: Map<string, string | true>; positional: string[]; rest: string[] };

export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | true>();
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
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new FactoryError("usage", `${name} needs a value`);
      flags.set(name, value);
    } else if (BOOL_FLAGS.has(a)) {
      flags.set(a, true);
    } else if (a.startsWith("-") && a !== "-") {
      throw new FactoryError("usage", `unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, rest };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function duration(p: Parsed, name: string, fallback: string): number {
  return parseDuration(str(p, name) ?? fallback);
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new FactoryError("usage", `missing ${what}`);
  return value;
}

type Outcome = { result: unknown; text: string; exitCode?: number };

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
      const r = approveRun(db, need(arg, "run_id"), {
        contractFile: need(str(p, "--contract"), "--contract <file>"),
        budgetMs: duration(p, "--run-budget", DEFAULTS.runBudget),
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
      const r = await execCommand(db, need(arg, "run_id"), p.rest, {
        owner,
        timeoutMs: duration(p, "--timeout", DEFAULTS.commandTimeout),
        lockWaitMs: duration(p, "--lock-timeout", DEFAULTS.lockTimeout),
        echo: !json,
      });
      const why = r.reason ? ` (${r.reason})` : "";
      return {
        result: r,
        text: `factory: ${r.outcome}${why}, exit ${r.exit_code ?? "-"}, ${(r.duration_ms / 1000).toFixed(1)}s, log ${r.log_path}`,
        exitCode: execExitCode(r),
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
      const r = await resumeRun(db, need(arg, "run_id"), {
        owner,
        lockWaitMs: duration(p, "--lock-timeout", DEFAULTS.lockTimeout),
      });
      const lines = [
        `${r.run.run_id}: ${r.run.state}${r.deadline_passed ? " (deadline passed: reconciled only)" : ""}`,
        ...(r.actions.length ? r.actions.map((a) => `  attempt ${a.attempt} (${a.found}): ${a.action}${a.detail ? ` — ${a.detail}` : ""}`) : ["  nothing to reconcile"]),
        ...r.released_locks.map((l) => `  released stale lock ${l}`),
      ];
      return { result: r, text: lines.join("\n") };
    }
    case "revoke": {
      const a = revokeRun(db, need(arg, "run_id"));
      return { result: { authorization: a }, text: `${a.run_id}: authorization ${a.contract_digest} revoked` };
    }
    default:
      throw new FactoryError("usage", `unknown command ${command}`);
  }
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
        JSON.stringify({ ok: false, command, error: { code: fe.code, kind: fe.kind, message: fe.message } }) + "\n",
      );
    } else {
      console.error(`factory: ${fe.message}`);
      if (fe.code === "usage") console.error(`\n${USAGE}`);
    }
    return fe.kind === "blocked" ? 2 : 1;
  };

  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return fail(err);
  }
  command = parsed.positional.shift() ?? "";
  if (!command || parsed.flags.has("--help") || parsed.flags.has("-h")) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  let db: Database | undefined;
  try {
    db = initManifest({ dataDir: str(parsed, "--data-dir") });
    db.pragma("busy_timeout = 10000");
    const out = await dispatch(db, command, parsed, jsonRequested);
    if (jsonRequested) {
      process.stdout.write(JSON.stringify({ ok: true, command, result: out.result }) + "\n");
    } else {
      // exec's own output was streamed; its summary goes to stderr.
      (command === "exec" ? console.error : console.log)(out.text);
    }
    return out.exitCode ?? 0;
  } catch (err) {
    return fail(err);
  } finally {
    db?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
