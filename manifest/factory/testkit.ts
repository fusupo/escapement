// Shared helpers for the factory test suites. Every test works in a fresh
// temporary directory and database; the real manifest is never opened.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

export function throws(fn: () => unknown, pattern: RegExp, msg: string): void {
  try {
    fn();
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ""} ${String(err)}`;
    assert(pattern.test(text), `${msg} (${String(err)})`);
    return;
  }
  assert(false, `${msg}: expected an error`);
}

const tempDirs: string[] = [];

// Tests never read the user's own agent identity (~/.config/escapement/agent.env).
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "factory-config-"));
tempDirs.push(process.env.XDG_CONFIG_HOME);
delete process.env.ESCAPEMENT_AGENT_GH_TOKEN;
delete process.env.ESCAPEMENT_AGENT_NAME;
delete process.env.ESCAPEMENT_AGENT_EMAIL;

export function tempDir(prefix = "factory-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/** A git repository with one commit on `branch` and an optional origin URL. */
export function makeRepo(opts: { branch?: string; origin?: string; claudeMd?: string } = {}): string {
  const root = tempDir("factory-repo-");
  sh("git", ["init", "-q", "-b", opts.branch ?? "1-work"], root);
  if (opts.origin) sh("git", ["remote", "add", "origin", opts.origin], root);
  writeFileSync(join(root, "README.md"), "test\n");
  if (opts.claudeMd !== undefined) writeFileSync(join(root, "CLAUDE.md"), opts.claudeMd);
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", "init"], root);
  return root;
}

/** A fresh in-memory database at the latest schema. */
export async function memDb() {
  const { default: Database } = await import("better-sqlite3");
  const { migrate } = await import("../migrations.ts");
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** Insert a run row directly, bypassing `factory start`. */
export function seedRun(
  db: import("better-sqlite3").Database,
  runId: string,
  fields: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    run_id: runId,
    work_item: "w",
    repo: "o/r",
    worktree_path: "/wt",
    branch: "b",
    target_ref: "main",
    artifact_dir: "/artifacts",
    state: "planned",
    started_at: new Date().toISOString(),
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO factory_runs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((c) => row[c]),
  );
}

/** A minimal valid contract for `runId`, with optional overrides. */
export function contractJson(runId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    run_id: runId,
    risk_tier_proposed: "standard",
    criteria: [
      { id: "AC-1", text: "It works", evidence: [{ id: "AC-1.e1", type: "test", kind: "new_behavior", selector: "test.ts::works" }] },
    ],
    ...extra,
  });
}

/** Write contractJson(runId) to a fresh temporary file and return its path. */
export function contractFor(runId: string, extra: Record<string, unknown> = {}): string {
  const file = join(tempDir("factory-contract-"), "contract.json");
  writeFileSync(file, contractJson(runId, extra));
  return file;
}

// ── a stub `gh` ───────────────────────────────────────────────────────

export type StubPr = {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  owner: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
};
export type StubState = {
  user: { login: string; id: number };
  prs: StubPr[];
  /** Exit 1 after performing this subcommand ("create", "edit"), as if gh crashed after GitHub acted. */
  crashAfter?: string | null;
  /** Fail this subcommand without acting. */
  failOn?: string | null;
};
export type GhCall = { args: string[]; token: string | null; githubToken: string | null; body?: string };

/**
 * A fake `gh` on PATH for the factory tests: it serves `api user`,
 * `pr list | create | view` and the PR update the runner makes
 * (`api -X PATCH repos/{repo}/pulls/{n}`, called "edit" for crashAfter and
 * failOn) from a JSON state file, and logs every call (argv and whether
 * GH_TOKEN was set) to a JSONL file. Like a repository where classic
 * Projects are deprecated, `pr edit` fails. Nothing leaves the machine.
 */
export function stubGh(initial: Partial<StubState> = {}) {
  const dir = tempDir("factory-gh-");
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");
  const state: StubState = { user: { login: "agent-bot", id: 4242 }, prs: [], crashAfter: null, failOn: null, ...initial };
  writeFileSync(statePath, JSON.stringify(state));
  const script = `#!/usr/bin/env node
const fs = require("fs");
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync(statePath, "utf-8"));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const entry = { args, token: process.env.GH_TOKEN ?? null, githubToken: process.env.GITHUB_TOKEN ?? null };
const fields = {};
args.forEach((a, i) => { if ((a === "-F" || a === "-f") && args[i + 1]) { const [k, ...v] = args[i + 1].split("="); fields[k] = v.join("="); } });
const bodyFile = flag("--body-file") || (fields.body && fields.body.startsWith("@") ? fields.body.slice(1) : undefined);
if (bodyFile) entry.body = fs.readFileSync(bodyFile, "utf-8");
fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const save = () => fs.writeFileSync(statePath, JSON.stringify(st));
const patch = args[0] === "api" && args.includes("PATCH") ? (args.find((a) => a.startsWith("repos/") && a.includes("/pulls/")) || "") : null;
const sub = patch !== null ? "edit" : args[0] === "pr" ? args[1] : args[0];
if (st.failOn === sub) { process.stderr.write("stub gh: " + sub + " failed for token " + process.env.GH_TOKEN + "\\n"); process.exit(1); }
const done = (out) => {
  if (out !== undefined) process.stdout.write(out + "\\n");
  if (st.crashAfter === sub) { process.stderr.write("stub gh: crashed after " + sub + "\\n"); process.exit(1); }
  process.exit(0);
};
const view = (p) => ({ number: p.number, url: p.url, title: p.title, body: p.body, headRefName: p.headRefName,
  baseRefName: p.baseRefName, headRepositoryOwner: { login: p.owner }, state: p.state, mergedAt: p.mergedAt });
if (args[0] === "api" && args[1] === "user") done(JSON.stringify(st.user));
if (patch !== null) {
  const pr = st.prs.find((p) => p.number === Number(patch.split("/").pop()));
  if (!pr) { process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(1); }
  if (entry.body !== undefined) pr.body = entry.body;
  if (fields.title) pr.title = fields.title;
  save();
  done(JSON.stringify({ number: pr.number, html_url: pr.url }));
}
if (args[0] === "pr" && args[1] === "edit") {
  process.stderr.write("GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience (repository.pullRequest.projectCards)\\n");
  process.exit(1);
}
if (args[0] !== "pr") { process.stderr.write("stub gh: unsupported " + args.join(" ") + "\\n"); process.exit(2); }
const repo = flag("-R") || "";
const owner = repo.split("/").slice(-2)[0];
if (sub === "list") {
  const head = flag("--head");
  const state = (flag("--state") || "open").toUpperCase();
  done(JSON.stringify(st.prs.filter((p) => (!head || p.headRefName === head) && (state === "ALL" || p.state === state)).map(view)));
}
if (sub === "create") {
  const number = 100 + st.prs.length + 1;
  const url = "https://github.com/" + repo + "/pull/" + number;
  st.prs.push({ number, url, title: flag("--title"), body: entry.body ?? "", headRefName: flag("--head"),
    baseRefName: flag("--base"), owner, state: "OPEN", mergedAt: null });
  save();
  done(url);
}
const number = Number(args[2]);
const pr = st.prs.find((p) => p.number === number);
if (!pr) { process.stderr.write("stub gh: no pull request " + args[2] + "\\n"); process.exit(1); }
if (sub === "view") done(JSON.stringify(view(pr)));
process.stderr.write("stub gh: unsupported " + args.join(" ") + "\\n");
process.exit(2);
`;
  const bin = join(dir, "gh");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return {
    dir,
    /** PATH with the stub first. */
    path: `${dir}:${process.env.PATH ?? ""}`,
    state: (): StubState => JSON.parse(readFileSync(statePath, "utf-8")),
    setState: (patch: Partial<StubState>) => writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf-8")), ...patch })),
    calls: (): GhCall[] =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as GhCall)
        : [],
  };
}
