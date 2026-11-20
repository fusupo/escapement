// Session discovery (#89): scripts/find-session-transcripts.py finds the
// Claude Code transcripts of every session that worked on an issue, in the
// main checkout, the worktrees and worktrees that are gone. Each case runs
// the real script's `find` against a temp repository and a temp projects
// directory laid out the way Claude Code lays it out.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(repoRoot, "scripts", "find-session-transcripts.py");

/** Claude Code's project directory name: every character that isn't a letter or digit becomes "-". */
const encode = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
/** A name over 200 characters is cut to 200 and given a suffix. */
const dirName = (path: string) => (encode(path).length > 200 ? `${encode(path).slice(0, 200)}-1x2y3z` : encode(path));

const ISSUE = "89-archive-every-session";
const BASE = "develop";
const SINCE = "2026-11-20T08:00:00.000Z";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "session-discovery-")));
const projects = join(tmp, "claude", "projects");
const main = join(tmp, "repo");
const managed = join(tmp, ".local", "share", "escapement", "worktrees", "o-r");
const worktree = join(managed, "89-x"); // listed, on the issue branch
const removedManaged = join(managed, "gone"); // never exists: removed
const removedRun = join(tmp, "elsewhere", "run-wt"); // a run's worktree_path, removed
const longPath = join(tmp, "elsewhere", "b".repeat(230)); // encoded name over 200
const unrelated = join(tmp, "unrelated");

const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
delete env.GIT_DIR;
delete env.GIT_WORK_TREE;
delete env.CLAUDE_CONFIG_DIR;

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`FAIL: git ${args.join(" ")}: ${r.stderr}`);
}

type Entry = { branch?: string; cwd: string; at: string };
let ids = 0;
/** Write a transcript into the project directory of `project`; returns its session id. */
function transcript(project: string, entries: Entry[], opts: { id?: string; sub?: string } = {}): string {
  const id = opts.id ?? `00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}`;
  const dir = join(projects, dirName(project), opts.sub ?? "");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "mode", sessionId: id }),
    ...entries.map((e) => JSON.stringify({ type: "user", sessionId: id, cwd: e.cwd, gitBranch: e.branch, timestamp: e.at })),
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  return id;
}

function find(extra: string[] = []) {
  const r = spawnSync(
    "python3",
    ["-I", SCRIPT, "find", "--branch", ISSUE, "--base", BASE, "--claude-dir", join(tmp, "claude"), "--managed-base", managed, ...extra],
    { cwd: main, env, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`FAIL: find exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout) as { sessions: { session_id: string; root: string; branches: Record<string, number> }[] };
  return { ids: out.sessions.map((s) => s.session_id), byId: Object.fromEntries(out.sessions.map((s) => [s.session_id, s])) };
}

try {
  mkdirSync(main);
  git(main, "init", "-q", "-b", BASE);
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(managed, { recursive: true });
  git(main, "worktree", "add", "-q", "-b", ISSUE, worktree);

  // Setup in the main checkout: on develop, then on the issue branch.
  const setup = transcript(main, [
    { branch: BASE, cwd: main, at: "2026-11-20T07:00:00Z" },
    { branch: ISSUE, cwd: main, at: "2026-11-20T07:30:00Z" },
  ]);
  // The run's session in the listed worktree, never compacted.
  const run = transcript(worktree, [
    { branch: ISSUE, cwd: worktree, at: "2026-11-20T08:10:00Z" },
    { branch: ISSUE, cwd: join(worktree, "manifest"), at: "2026-11-20T08:20:00Z" },
  ]);
  // A session in the run's (now removed) worktree on a detached HEAD only,
  // inside the run's time: kept by the window, not by branch.
  const windowed = transcript(removedRun, [{ branch: "HEAD", cwd: removedRun, at: "2026-11-20T09:00:00Z" }]);
  // An earlier run's session in the same, reused worktree path, before the run.
  const earlier = transcript(removedRun, [{ branch: "42-other", cwd: removedRun, at: "2026-11-19T09:00:00Z" }]);
  // A session in a managed worktree that has been removed.
  const gone = transcript(removedManaged, [{ branch: ISSUE, cwd: join(removedManaged, "manifest"), at: "2026-11-20T10:00:00Z" }]);
  // A main-checkout session that never touched the issue branch.
  const mainOther = transcript(main, [
    { branch: BASE, cwd: main, at: "2026-11-20T06:00:00Z" },
    { branch: "42-other", cwd: main, at: "2026-11-20T06:30:00Z" },
  ]);
  // A subagent transcript of the run session, in its subdirectory.
  const subagent = transcript(worktree, [{ branch: ISSUE, cwd: worktree, at: "2026-11-20T08:15:00Z" }], { sub: join(run, "subagents") });
  // A session on a branch of the same name in another repository's project.
  const elsewhere = transcript(unrelated, [{ branch: ISSUE, cwd: unrelated, at: "2026-11-20T08:00:00Z" }]);
  // The session running archive-work.
  const current = transcript(worktree, [{ branch: ISSUE, cwd: worktree, at: "2026-11-20T11:00:00Z" }]);
  // A run worktree whose encoded path is over 200 characters.
  const long = transcript(longPath, [{ branch: ISSUE, cwd: longPath, at: "2026-11-20T12:00:00Z" }]);

  const withWindow = find(["--extra-worktree", removedRun, "--since", SINCE, "--exclude-session", current]);
  const noWindow = find(["--extra-worktree", removedRun, "--exclude-session", current]);

  console.log("find-session-transcripts.py find\n");
  assert(
    withWindow.ids.includes(run) &&
      withWindow.ids.includes(setup) &&
      withWindow.ids.includes(windowed) &&
      withWindow.byId[run].root === worktree &&
      withWindow.byId[setup].root === main &&
      !noWindow.ids.includes(windowed) &&
      noWindow.ids.includes(run),
    "discovery keeps a transcript whose entries ran on the issue branch, or in the run's worktree during the run's time window",
  );

  assert(
    !withWindow.ids.includes(earlier) && !noWindow.ids.includes(earlier),
    "discovery does not keep an earlier session in a reused worktree path that ran on another branch before the run started",
  );

  assert(
    !existsSync(removedRun) &&
      !existsSync(removedManaged) &&
      withWindow.byId[windowed]?.root === removedRun &&
      withWindow.byId[gone]?.root === removedManaged &&
      noWindow.byId[gone]?.root === removedManaged,
    "discovery finds a transcript for a worktree that was removed, from the run's worktree_path and from the managed worktree directory",
  );

  const order = withWindow.ids.filter((id) => [setup, run, windowed, gone].includes(id));
  assert(
    encode("/home/marc/escapement-run-80") === "-home-marc-escapement-run-80" &&
      encode("/home/marc/.hyperframes/studio") === "-home-marc--hyperframes-studio" &&
      dirName(managed).includes("--local-share-escapement-worktrees-o-r") &&
      existsSync(join(projects, dirName(worktree), `${run}.jsonl`)) &&
      existsSync(join(projects, dirName(worktree), run, "subagents", `${subagent}.jsonl`)) &&
      !withWindow.ids.includes(subagent) &&
      !withWindow.ids.includes(elsewhere) &&
      !withWindow.ids.includes(mainOther) &&
      !withWindow.ids.includes(current) &&
      noWindow.ids.includes(run) &&
      order.join() === [setup, run, windowed, gone].join(),
    "discovery encodes paths as Claude Code does, ignores subagent subdirectories and unrelated sessions, and excludes the current session",
  );

  const longFound = find(["--extra-worktree", longPath, "--exclude-session", current]);
  assert(
    encode(longPath).length > 200 &&
      existsSync(join(projects, `${encode(longPath).slice(0, 200)}-1x2y3z`, `${long}.jsonl`)) &&
      longFound.ids.includes(long) &&
      longFound.byId[long].root === longPath &&
      !find(["--exclude-session", current]).ids.includes(long),
    "discovery matches a path whose encoded name is over 200 characters by prefix",
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
