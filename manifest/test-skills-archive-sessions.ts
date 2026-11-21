// archive-work Phase 1.6 (#89): every session that worked on the issue is
// archived, not only the one running archive-work. Blocks A and B are run as
// written in SKILL.md, with the real slicer, gate and discovery scripts, a
// stub runner that records its arguments, a temp repository with a run
// worktree, and a temp Claude Code projects directory. Between the blocks,
// the test reads the pending list and plays the operator.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(repoRoot, "skills", "archive-work", "SKILL.md"), "utf-8");

/** The text of a `### ` section, up to the next `## ` or `### ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const m = /\n#{2,3} /g;
  m.lastIndex = start + heading.length;
  const next = m.exec(text);
  return text.slice(start, next ? next.index : undefined);
}

/** The numbered step `n.` of a section, up to the next numbered step. */
function step(text: string, n: number): string {
  const start = text.search(new RegExp(`\\n${n}\\. `));
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(new RegExp(`\\n${n + 1}\\. `));
  return next < 0 ? rest : rest.slice(0, next);
}

const bashBlock = (text: string) => (text.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "").replace(/^ {3}/gm, "");

const phase16 = section(skill, "### Phase 1.6: Capture Other Sessions");
const blockA = bashBlock(step(phase16, 1)).replaceAll("{issue_number}", "89");
const blockBTemplate = bashBlock(step(phase16, 3));
const KEYS = "{keys the operator included, comma-separated}";

const ISSUE = "89-x";
const BASE = "develop";
const RUN_ID = "o-r#89-r1";
const SINCE = "2026-11-20T08:00:00.000Z";

const encode = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
const ls = (dir: string) => readdirSync(dir).filter((f) => f.startsWith("SESSION_LOG_")).sort().join(",");

type Entry = { branch?: string; cwd: string; at: string };
type Pending = {
  key: string;
  kind: "slice" | "hook_log";
  session_id: string;
  file: string;
  root: string;
  start: number | null;
  end: number | null;
  lines: number;
  size: number;
  decision: string;
  reason: string;
  branches: Record<string, number>;
  first: string;
  last: string;
};

/** A fresh repository, run worktree, plugin and projects directory. */
class World {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "archive-sessions-")));
  main = join(this.tmp, "repo");
  managed = join(this.tmp, "data", "worktrees", "o-r");
  wt = join(this.managed, "run-89");
  plugin = join(this.tmp, "plugin");
  claude = join(this.tmp, "claude");
  state = join(this.tmp, "state");
  args = join(this.tmp, "runner-args");
  env: NodeJS.ProcessEnv;
  private ids = 0;

  constructor(opts: { run?: boolean } = {}) {
    const scripts = join(this.plugin, "scripts");
    mkdirSync(scripts, { recursive: true });
    for (const f of ["slice-session-log.sh", "session-tail-gate.py", "find-session-transcripts.py"]) {
      copyFileSync(join(repoRoot, "scripts", f), join(scripts, f));
    }
    writeFileSync(
      join(scripts, "factory.sh"),
      [
        'printf "%s\\n" "$*" >> "$STUB_ARGS"',
        'case "$2" in',
        '  check) echo \'{"ok":true,"command":"check","result":{"status":"ready","target_ref":"develop"}}\' ;;',
        '  status) if [ "$3" = --all ]; then',
        '      if [ -n "$STUB_RUNS" ]; then printf "%s\\n" "$STUB_RUNS"; else echo \'{"ok":true,"result":{"runs":[]}}\'; fi',
        '    elif [ -n "$STUB_STATUS" ]; then printf "%s\\n" "$STUB_STATUS"; else echo \'{"ok":false}\'; exit 1; fi ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );
    writeFileSync(join(scripts, "worktree.sh"), '[ "$1" = path ] && echo "$STUB_MANAGED/$2"\n');

    const status =
      opts.run === false
        ? ""
        : JSON.stringify({
            ok: true,
            command: "status",
            result: { run: { branch: ISSUE, worktree_path: this.wt, started_at: SINCE, ended_at: null } },
          });
    this.env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: this.tmp,
      CLAUDE_CONFIG_DIR: this.claude,
      XDG_STATE_HOME: this.state,
      CLAUDE_PLUGIN_ROOT: this.plugin,
      CLAUDE_CODE_SESSION_ID: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      STUB_ARGS: this.args,
      STUB_STATUS: status,
      STUB_MANAGED: this.managed,
    };
    delete this.env.GIT_DIR;
    delete this.env.GIT_WORK_TREE;

    mkdirSync(this.main);
    this.git(this.main, "init", "-q", "-b", BASE);
    this.git(this.main, "commit", "-q", "--allow-empty", "-m", "init");
    // The runner names this repository o/r, from its origin (#129).
    this.git(this.main, "remote", "add", "origin", "git@github.com:o/r.git");
    mkdirSync(this.managed, { recursive: true });
    this.git(this.main, "worktree", "add", "-q", "-b", ISSUE, this.wt);
    // Archiving from the main checkout after the merge, as usual.
    const runLine = opts.run === false ? "" : `- **Run:** ${RUN_ID} (approved 2026-11-20T08:00:00.000Z)\n`;
    writeFileSync(join(this.main, "SCRATCHPAD_89.md"), `# x\n\n## Factory Run\n${runLine}\n## Branch Strategy\n- **Feature branch:** ${ISSUE}\n`);
    writeFileSync(this.args, "");
  }

  git(cwd: string, ...args: string[]) {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: this.env, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`FAIL: git ${args.join(" ")}: ${r.stderr}`);
  }

  /** A session transcript in the project directory of `project`; returns its id and path. */
  transcript(project: string, entries: Entry[]) {
    const id = `00000000-0000-0000-0000-${String(++this.ids).padStart(12, "0")}`;
    const dir = join(this.claude, "projects", encode(project));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, this.lines(id, entries));
    return { id, path };
  }

  lines(id: string, entries: Entry[]) {
    return entries.map((e) => JSON.stringify({ type: "user", sessionId: id, cwd: e.cwd, gitBranch: e.branch, timestamp: e.at }) + "\n").join("");
  }

  slicer(...args: string[]) {
    const r = spawnSync("bash", [join(this.plugin, "scripts", "slice-session-log.sh"), ...args], { env: this.env, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`FAIL: slicer ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }

  cursor(id: string): string | null {
    const f = join(this.state, "escapement", "session-cursors", id);
    return existsSync(f) ? readFileSync(f, "utf-8").trim() : null;
  }

  pendingPath() {
    return join(this.main, ".git", "escapement-session-pending.json");
  }

  /** Block A, as written. */
  blockA(): { pending: Pending[]; errors: string[]; stdout: string; stderr: string } {
    const r = spawnSync("bash", ["-c", blockA], { cwd: this.main, env: this.env, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`FAIL: block A exited ${r.status}: ${r.stderr}${r.stdout}`);
    if (!r.stdout.trim().startsWith("{")) return { pending: [], errors: [], stdout: r.stdout.trim(), stderr: r.stderr };
    const doc = JSON.parse(r.stdout);
    return { pending: doc.entries, errors: doc.errors, stdout: r.stdout.trim(), stderr: r.stderr };
  }

  /** Block B, as written, with the operator's selection. */
  blockB(keys: string[] = []): string[] {
    const block = blockBTemplate.replace(KEYS, keys.join(","));
    const r = spawnSync("bash", ["-c", block], { cwd: this.main, env: this.env, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`FAIL: block B exited ${r.status}: ${r.stderr}${r.stdout}`);
    return r.stdout.trim().split("\n");
  }

  runnerArgs() {
    return readFileSync(this.args, "utf-8").trim().split("\n");
  }

  done() {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

function test(fn: (w: World) => void, opts?: ConstructorParameters<typeof World>[0]) {
  const w = new World(opts);
  try {
    fn(w);
  } finally {
    w.done();
  }
}

const on = (branch: string, cwd: string, minute: number, hour = 9): Entry => ({
  branch,
  cwd,
  at: `2026-11-20T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`,
});

console.log("archive-work Phase 1.6: the blocks, run as written\n");

if (!blockA.includes("find-session-transcripts.py\" prepare") || !blockBTemplate.includes(`finish --include '${KEYS}'`)) {
  throw new Error("FAIL: Phase 1.6's blocks A and B were not found in SKILL.md");
}

// AC-1: a factory run's session in its own worktree, never compacted.
test((w) => {
  const run = w.transcript(w.wt, [on("HEAD", w.wt, 1), on(ISSUE, w.wt, 2), on(ISSUE, join(w.wt, "manifest"), 3)]);
  const a = w.blockA();
  const slice = join(w.main, "SESSION_LOG_1.jsonl");
  const afterA = { cursor: w.cursor(run.id), files: ls(w.main), pending: existsSync(w.pendingPath()) };
  const out = w.blockB();
  assert(
    a.pending.length === 1 &&
      a.pending[0].kind === "slice" &&
      a.pending[0].decision === "include" &&
      a.pending[0].root === w.wt &&
      a.pending[0].start === 1 &&
      a.pending[0].end === 3 &&
      afterA.cursor === null &&
      afterA.files === "SESSION_LOG_1.jsonl" &&
      afterA.pending &&
      readFileSync(slice, "utf-8") === readFileSync(run.path, "utf-8") &&
      w.cursor(run.id) === "3" &&
      out.join() === `SESSION_LOG_1 <- session ${run.id.slice(0, 8)} (${w.wt}, lines 1-3)` &&
      !existsSync(w.pendingPath()) &&
      w.runnerArgs().join("|") === `--json check|--json status ${RUN_ID}|--json status --all`,
    "Phase 1.6 blocks A and B slice a never-compacted session from a run worktree into SESSION_LOG_{N}.jsonl and commit its cursor",
  );
});

// AC-1: hook logs the PreCompact hook wrote into the run worktree's root.
test((w) => {
  const entries = [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2), on(ISSUE, w.wt, 3), on(ISSUE, w.wt, 4)];
  const run = w.transcript(w.wt, entries);
  // The hook sliced lines 1-2 at a compaction, into the worktree's root.
  writeFileSync(run.path, w.lines(run.id, entries.slice(0, 2)));
  w.slicer("slice", run.path, w.wt);
  writeFileSync(run.path, w.lines(run.id, entries));
  const hookLog = join(w.wt, "SESSION_LOG_1.jsonl");
  const hookContent = readFileSync(hookLog, "utf-8");
  const a = w.blockA();
  const out = w.blockB();
  const id8 = run.id.slice(0, 8);
  assert(
    a.pending.map((e) => `${e.kind}:${e.decision}`).join() === "slice:include,hook_log:include" &&
      a.pending[1].file === hookLog &&
      a.pending[1].root === w.wt &&
      !existsSync(hookLog) &&
      readFileSync(join(w.main, "SESSION_LOG_2.jsonl"), "utf-8") === hookContent &&
      out.join("|") === `SESSION_LOG_1 <- session ${id8} (${w.wt}, lines 3-4)|SESSION_LOG_2 <- session ${id8} (${w.wt}, hook log SESSION_LOG_1.jsonl)` &&
      w.cursor(run.id) === "4",
    "Phase 1.6 adopts the hook logs of the issue's sessions from another existing worktree's root once they pass the gate",
  );
});

// AC-2: cursors are respected.
test((w) => {
  const done = w.transcript(w.wt, [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2)]);
  w.slicer("commit", done.path, "2");
  const partial = w.transcript(w.wt, [on(ISSUE, w.wt, 3), on(ISSUE, w.wt, 4), on(ISSUE, w.wt, 5), on(ISSUE, w.wt, 6), on(ISSUE, w.wt, 7)]);
  w.slicer("commit", partial.path, "3");
  const a = w.blockA();
  const out = w.blockB();
  const expected = readFileSync(partial.path, "utf-8").split("\n").slice(3, 5).join("\n") + "\n";
  // Archiving again with nothing new writes nothing at all.
  const again = w.blockA();
  const againOut = w.blockB();
  assert(
    a.pending.length === 1 &&
      a.pending[0].session_id === partial.id &&
      a.pending[0].start === 4 &&
      a.pending[0].end === 5 &&
      readFileSync(join(w.main, "SESSION_LOG_1.jsonl"), "utf-8") === expected &&
      out.join() === `SESSION_LOG_1 <- session ${partial.id.slice(0, 8)} (${w.wt}, lines 4-5)` &&
      w.cursor(done.id) === "2" &&
      w.cursor(partial.id) === "5" &&
      again.pending.length === 0 &&
      againOut.length === 1 &&
      againOut[0] === "" &&
      ls(w.main) === "SESSION_LOG_1.jsonl",
    "Phase 1.6 writes nothing for a session its cursor already covers, and only the new lines after a partial cursor",
  );
});

// AC-2: numbering across existing logs, several slices and an adopted hook log.
test((w) => {
  writeFileSync(join(w.main, "SESSION_LOG_1.jsonl"), "phase 1.5's tail\n");
  writeFileSync(join(w.main, "SESSION_LOG_2.md"), "# a converted log\n");
  const one = w.transcript(w.wt, [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2)]);
  const two = w.transcript(w.wt, [on(ISSUE, w.wt, 10), on(ISSUE, w.wt, 11)]);
  writeFileSync(join(w.wt, "SESSION_LOG_1.jsonl"), w.lines(two.id, [on(ISSUE, w.wt, 9)]));
  w.blockA();
  const out = w.blockB();
  assert(
    ls(w.main) === "SESSION_LOG_1.jsonl,SESSION_LOG_2.md,SESSION_LOG_3.jsonl,SESSION_LOG_4.jsonl,SESSION_LOG_5.jsonl" &&
      readFileSync(join(w.main, "SESSION_LOG_1.jsonl"), "utf-8") === "phase 1.5's tail\n" &&
      readFileSync(join(w.main, "SESSION_LOG_2.md"), "utf-8") === "# a converted log\n" &&
      readFileSync(join(w.main, "SESSION_LOG_3.jsonl"), "utf-8") === readFileSync(one.path, "utf-8") &&
      readFileSync(join(w.main, "SESSION_LOG_4.jsonl"), "utf-8") === readFileSync(two.path, "utf-8") &&
      readFileSync(join(w.main, "SESSION_LOG_5.jsonl"), "utf-8").includes(two.id) &&
      out.map((l) => l.split(" ")[0]).join() === "SESSION_LOG_3,SESSION_LOG_4,SESSION_LOG_5",
    "Phase 1.6 numbers the logs of several sessions and adopted hook logs without colliding with existing .jsonl or .md logs",
  );
});

// AC-3: a session that also ran on another branch is offered, not included.
test((w) => {
  const mixed = w.transcript(w.wt, [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2), on("42-other", w.wt, 3)]);
  const first = w.blockA();
  const entry = first.pending[0];
  const declined = w.blockB();
  const afterDecline = { cursor: w.cursor(mixed.id), files: ls(w.main) };
  const second = w.blockA();
  const included = w.blockB([second.pending[0].key]);
  assert(
    first.pending.length === 1 &&
      entry.decision === "ask" &&
      entry.reason === "other_branch" &&
      entry.branches[ISSUE] === 2 &&
      entry.branches["42-other"] === 1 &&
      entry.size > 0 &&
      entry.lines === 3 &&
      entry.first === "2026-11-20T09:01:00.000Z" &&
      entry.last === "2026-11-20T09:03:00.000Z" &&
      declined.join().startsWith(`declined: session ${mixed.id.slice(0, 8)}`) &&
      afterDecline.cursor === null &&
      afterDecline.files === "" &&
      included.join() === `SESSION_LOG_1 <- session ${mixed.id.slice(0, 8)} (${w.wt}, lines 1-3)` &&
      w.cursor(mixed.id) === "3",
    "Phase 1.6 block A marks a session that also ran on another branch as ask, with its branches, size and time span, and block B includes it only when selected",
  );
});

test((w) => {
  const mixed = w.transcript(w.wt, [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2), on("42-other", w.wt, 3), on("42-other", w.wt, 4)]);
  w.slicer("commit", mixed.path, "1");
  const a = w.blockA();
  const slice = a.pending[0]?.file ?? "";
  const sliced = existsSync(slice);
  const out = w.blockB();
  assert(
    a.pending[0]?.decision === "ask" &&
      sliced &&
      !existsSync(slice) &&
      w.cursor(mixed.id) === "1" &&
      ls(w.main) === "" &&
      out.join().startsWith("declined:"),
    "Phase 1.6 block B leaves a declined session's cursor unmoved and removes its slice",
  );
});

test((w) => {
  const s = w.transcript(w.wt, [on(ISSUE, w.wt, 1), on(ISSUE, w.wt, 2)]);
  const hookLog = join(w.wt, "SESSION_LOG_1.jsonl");
  const content = w.lines(s.id, [on("42-other", w.wt, 0, 8), on(ISSUE, w.wt, 0)]);
  writeFileSync(hookLog, content);
  w.slicer("commit", s.path, "2");
  const a = w.blockA();
  const out = w.blockB();
  assert(
    a.pending.length === 1 &&
      a.pending[0].kind === "hook_log" &&
      a.pending[0].decision === "ask" &&
      existsSync(hookLog) &&
      readFileSync(hookLog, "utf-8") === content &&
      ls(w.wt) === "SESSION_LOG_1.jsonl" &&
      ls(w.main) === "" &&
      out.join() === `declined: hook log ${hookLog} (session ${s.id.slice(0, 8)}), left in its worktree`,
    "Phase 1.6 leaves a declined hook log in its worktree under its own name",
  );
});

test((w) => {
  w.transcript(w.wt, [on(ISSUE, w.wt, 1), on("42-other", w.wt, 2)]);
  w.transcript(w.main, [on(BASE, w.main, 3), on(ISSUE, w.main, 4), on("43-other", w.main, 5)]);
  const s = w.transcript(w.wt, [on(ISSUE, w.wt, 6)]);
  writeFileSync(join(w.wt, "SESSION_LOG_1.jsonl"), w.lines(s.id, [on("44-other", w.wt, 0)]));
  const a = w.blockA();
  const s2 = step(phase16, 2);
  const asks = (phase16.match(/AskUserQuestion:/g) ?? []).length;
  assert(
    asks === 1 &&
      s2.includes("ask about all of them in one `AskUserQuestion` call, one question per entry") &&
      s2.includes('question: "{Session | Hook log} {key} ({root}, {lines} lines, {size}, {first} to {last}) ran on branches {branch: count, ...}. Include it in this archive?"') &&
      s2.includes('label: "Include in this archive"') &&
      s2.includes('label: "Leave for a later log"') &&
      s2.includes("With no `ask` entry, don't ask.") &&
      a.pending.filter((e) => e.decision === "ask").map((e) => e.kind).join() === "slice,slice,hook_log" &&
      a.pending.length === 4 &&
      new Set(a.pending.map((e) => e.key)).size === 4 &&
      a.pending.find((e) => e.decision === "include")?.session_id === s.id,
    "Phase 1.6 asks one question for all undecided sessions and hook logs",
  );
});

// AC-4: the session's worktree is gone.
test((w) => {
  // The run's worktree_path, removed after the run (outside the managed directory).
  const gone = join(w.tmp, "elsewhere", "run-80");
  w.env.STUB_STATUS = JSON.stringify({
    ok: true,
    command: "status",
    result: { run: { branch: ISSUE, worktree_path: gone, started_at: SINCE, ended_at: null } },
  });
  const fromRun = w.transcript(gone, [on("HEAD", gone, 1), on(ISSUE, join(gone, "manifest"), 2)]);
  // A managed worktree, removed, that no run names.
  const managedGone = join(w.managed, "gone");
  const fromManaged = w.transcript(managedGone, [on("HEAD", managedGone, 3), on(ISSUE, join(managedGone, "scripts"), 4)]);
  const a = w.blockA();
  const out = w.blockB();
  const byId = Object.fromEntries(a.pending.map((e) => [e.session_id, e]));
  assert(
    !existsSync(gone) &&
      !existsSync(managedGone) &&
      byId[fromRun.id]?.root === gone &&
      byId[fromRun.id]?.decision === "include" &&
      byId[fromManaged.id]?.root === managedGone &&
      byId[fromManaged.id]?.decision === "include" &&
      w.cursor(fromRun.id) === "2" &&
      w.cursor(fromManaged.id) === "2" &&
      ls(w.main) === "SESSION_LOG_1.jsonl,SESSION_LOG_2.jsonl" &&
      out.length === 2,
    "Phase 1.6 archives a session whose worktree was removed, with its root taken from worktree_path or the managed directory",
  );
});

// AC-5: several sessions, in order, each log naming its session.
test((w) => {
  const third = w.transcript(w.wt, [on(ISSUE, w.wt, 30)]);
  const first = w.transcript(w.main, [on(ISSUE, w.main, 10)]);
  const second = w.transcript(w.wt, [on(ISSUE, w.wt, 20)]);
  const a = w.blockA();
  const out = w.blockB();
  assert(
    a.pending.map((e) => e.session_id).join() === [first.id, second.id, third.id].join() &&
      out.join("|") ===
        [
          `SESSION_LOG_1 <- session ${first.id.slice(0, 8)} (${w.main}, lines 1-1)`,
          `SESSION_LOG_2 <- session ${second.id.slice(0, 8)} (${w.wt}, lines 1-1)`,
          `SESSION_LOG_3 <- session ${third.id.slice(0, 8)} (${w.wt}, lines 1-1)`,
        ].join("|") &&
      readFileSync(join(w.main, "SESSION_LOG_1.jsonl"), "utf-8").includes(first.id) &&
      readFileSync(join(w.main, "SESSION_LOG_3.jsonl"), "utf-8").includes(third.id),
    "Phase 1.6 slices several sessions in order and reports which session each log came from",
  );
});

// Without a run, the scratchpad's feature branch is the issue branch; on the
// base branch with neither, nothing is searched.
test((w) => {
  const s = w.transcript(w.wt, [on(ISSUE, w.wt, 1)]);
  const a = w.blockA();
  w.blockB();
  writeFileSync(join(w.main, "SCRATCHPAD_89.md"), "# x\n");
  const none = w.blockA();
  assert(
    a.pending.length === 1 &&
      a.pending[0].session_id === s.id &&
      w.runnerArgs().every((l) => !l.startsWith("--json status") || l === "--json status --all") &&
      none.stdout === "Other sessions not searched: no issue branch",
    "Phase 1.6 takes the issue branch from the scratchpad without a run, and searches nothing on the base branch without one",
  );
}, { run: false });

// #129: block A passes this repository's recorded runs to discovery.
test((w) => {
  // An earlier run of this repository, its worktree since removed, and a run
  // of another repository whose worktree holds a same-branch session.
  const oldRun = join(w.tmp, "elsewhere", "o-r-old-run");
  const otherRun = join(w.tmp, "elsewhere", "x-y-run");
  w.env.STUB_RUNS = JSON.stringify({
    ok: true,
    command: "status",
    result: {
      runs: [
        { run_id: RUN_ID, repo: "o/r", worktree_path: w.wt },
        { run_id: "o-r#70-r1", repo: "o/r", worktree_path: oldRun },
        { run_id: "x-y#89-r1", repo: "x/y", worktree_path: otherRun },
      ],
    },
  });
  const fromOld = w.transcript(oldRun, [on(ISSUE, oldRun, 1)]);
  const fromOther = w.transcript(otherRun, [on(ISSUE, otherRun, 2)]);
  const a = w.blockA();
  w.blockB();
  const ids = a.pending.map((e) => e.session_id);
  assert(
    !existsSync(oldRun) &&
      ids.includes(fromOld.id) &&
      a.pending.find((e) => e.session_id === fromOld.id)?.root === oldRun &&
      !ids.includes(fromOther.id) &&
      w.runnerArgs().includes("--json status --all") &&
      w.cursor(fromOld.id) === "1" &&
      w.cursor(fromOther.id) === null,
    "Phase 1.6 block A passes this repository's recorded runs, so a removed run worktree is found and another repository's run worktree is not",
  );
});

// The current session is Phase 1.5's, and subagent transcripts are never archived.
test((w) => {
  const dir = join(w.claude, "projects", encode(w.wt));
  mkdirSync(join(dir, "11111111-1111-1111-1111-111111111111", "subagents"), { recursive: true });
  writeFileSync(join(dir, "11111111-1111-1111-1111-111111111111", "subagents", "agent-a.jsonl"), w.lines("agent-a", [on(ISSUE, w.wt, 1)]));
  writeFileSync(join(dir, "ffffffff-ffff-ffff-ffff-ffffffffffff.jsonl"), w.lines("ffffffff-ffff-ffff-ffff-ffffffffffff", [on(ISSUE, w.wt, 2)]));
  const a = w.blockA();
  w.blockB();
  assert(
    a.pending.length === 0 && ls(w.main) === "" && phase16.includes("Subagent transcripts are never archived"),
    "Phase 1.6 leaves out the current session (Phase 1.5's) and subagent transcripts",
  );
});

// The release: minimums, not the current versions, so a later release
// doesn't have to change this check (PROJECT_LORE).
{
  console.log("\nThe release (#89)\n");
  const atLeast = (v: string, min: string) => {
    const [a, b] = [v, min].map((x) => x.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
  const plugin = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf-8")).version as string;
  const version = /^\*\*Version:\*\* (\d+\.\d+\.\d+)$/m.exec(skill)?.[1] ?? "0.0.0";
  const current = /^\*\*Current:\*\* (\d+\.\d+\.\d+)$/m.exec(readme)?.[1] ?? "0.0.0";
  assert(
    atLeast(version, "2.9.0") &&
      /^- v2\.9\.0: Phase 1\.6 .*\(#89\)$/m.test(skill) &&
      atLeast(plugin, "4.10.0") &&
      atLeast(current, "4.10.0") &&
      /^- 4\.10\.0 \(\d{4}-\d{2}-\d{2}\): .*\(#89\)$/m.test(readme),
    "archive-work at least 2.9.0, a plugin and README Current of at least 4.10.0, and the changelogs carry a line for #89",
  );
}

console.log("\nAll archive-work Phase 1.6 tests passed.");
