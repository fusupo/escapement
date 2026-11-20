// archive-work's questions (#123): the session tail is decided by
// scripts/session-tail-gate.py, and Phase 5 isn't asked for a factory run
// whose PR merged. The text checks read SKILL.md; the Phase 1.5 gate block
// is also run as written, in a temp repository with a stub runner.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a `## ` or `### ` section, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const level = heading.match(/^#+/)?.[0] ?? "##";
  const next = new RegExp(`\\n#{2,${level.length}} `, "g");
  next.lastIndex = start + heading.length;
  const m = next.exec(text);
  return text.slice(start, m ? m.index : undefined);
}

/** The numbered step `n.` of a section, up to the next numbered step. */
function step(text: string, n: number): string {
  const start = text.search(new RegExp(`\\n${n}\\. `));
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(new RegExp(`\\n${n + 1}\\. `));
  return next < 0 ? rest : rest.slice(0, next);
}

const between = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  if (start < 0) return "";
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};
const prose = (text: string) => text.replace(/```[\s\S]*?```/g, "");

const skill = read("skills/archive-work/SKILL.md");
const front = skill.slice(0, skill.indexOf("\n---", 4));
const phase15 = section(skill, "### Phase 1.5: Capture Session Tail");
const phase2 = section(skill, "### Phase 2: Detect Artifacts");
const phase5 = section(skill, "### Phase 5: Confirm with User");
const phase65 = section(skill, "### Phase 6.5: Archive the Factory Run");

function sessionTail() {
  console.log("archive-work Phase 1.5: the session tail\n");
  const s2 = step(phase15, 2);
  const s3 = step(phase15, 3);
  const includeAt = s3.indexOf("**`include`:**");
  const askAt = s3.indexOf("**`ask`**");
  const questionAt = s3.indexOf("AskUserQuestion:");
  assert(
    s2.includes('python3 -I "${CLAUDE_PLUGIN_ROOT}/scripts/session-tail-gate.py" "$FILE"') &&
      s2.includes('--branch "$(git branch --show-current)"') &&
      s2.includes('--base "$BASE"') &&
      s2.includes('--root "$(git rev-parse --show-toplevel)"') &&
      !phase15.includes("collections.Counter") &&
      !/Every branch is the current branch/.test(phase15) &&
      s3.includes("from the script's `decision`") &&
      includeAt > 0 &&
      askAt > includeAt &&
      questionAt > askAt &&
      !s3.slice(includeAt, askAt).includes("AskUserQuestion") &&
      s3.slice(includeAt, askAt).includes('bash "$SLICER" commit "$TRANSCRIPT" "$END"') &&
      s3.includes(
        'question: "The session since the last log ({LINES} lines, {size}, {first} to {last}) ran on branches {branch: count, ...}. Include it in this archive?"',
      ) &&
      s3.includes('label: "Include in this archive"') &&
      s3.includes('label: "Leave for the next log"') &&
      /\*\*No decision\*\* \(the script failed\): ask the same question/.test(s3),
    "archive-work Phase 1.5 decides the session tail with scripts/session-tail-gate.py and asks only on its ask decision",
  );
}

/** Phase 1.5 step 2's bash block, as written, unindented. */
function gateBlock(): string {
  const block = step(phase15, 2).match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";
  return block.replace(/^ {3}/gm, "");
}

function gateBlockRuns() {
  console.log("\narchive-work Phase 1.5: the gate block, run as written\n");
  const block = gateBlock();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "archive-gate-")));
  try {
    // A stub plugin root: the real gate script and a fake runner.
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, "scripts"), { recursive: true });
    copyFileSync(join(root, "scripts", "session-tail-gate.py"), join(plugin, "scripts", "session-tail-gate.py"));
    writeFileSync(
      join(plugin, "scripts", "factory.sh"),
      [
        'printf "%s\\n" "$*" >> "$STUB_ARGS"',
        'case "$STUB_MODE" in',
        '  ref) echo \'{"ok":true,"command":"check","result":{"status":"needs_human","target_ref":"trunk"}}\' ;;',
        '  error) echo \'{"ok":false,"command":"check","error":{"code":"x","message":"y"}}\'; exit 1 ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"),
    );

    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`FAIL: git ${args.join(" ")}: ${r.stderr}`);
    };
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("checkout", "-q", "-b", "123-issue");

    const args = join(tmp, "args");
    let n = 0;
    const run = (mode: string, branches: string[]) => {
      const file = join(tmp, `slice-${++n}.jsonl`);
      writeFileSync(file, branches.map((gitBranch, i) => JSON.stringify({ gitBranch, cwd: repo, timestamp: `t${i}` })).join("\n") + "\n");
      writeFileSync(args, "");
      const r = spawnSync("bash", ["-c", block], {
        cwd: repo,
        env: { ...env, FILE: file, CLAUDE_PLUGIN_ROOT: plugin, STUB_MODE: mode, STUB_ARGS: args },
        encoding: "utf-8",
      });
      if (r.status !== 0) throw new Error(`FAIL: gate block exited ${r.status}: ${r.stderr}`);
      return { decision: JSON.parse(r.stdout).decision as string, args: readFileSync(args, "utf-8").trim() };
    };

    // The runner answers: its target_ref is the base branch.
    const fromCheck = run("ref", ["HEAD", "trunk", "123-issue"]);
    const otherBranch = run("ref", ["HEAD", "42-other", "123-issue"]);
    const headFirst = run("ref", ["HEAD", "123-issue"]);
    const developNotBase = run("ref", ["develop", "123-issue"]);
    // The runner fails or answers an error: origin/develop, else main.
    const noDevelop = [run("fail", ["main", "123-issue"]), run("fail", ["develop", "123-issue"]), run("error", ["main", "123-issue"])];
    git("update-ref", "refs/remotes/origin/develop", "HEAD");
    const withDevelop = [run("fail", ["develop", "123-issue"]), run("fail", ["main", "123-issue"]), run("error", ["develop", "123-issue"])];
    // Archiving on a detached HEAD: no issue branch, the old rule.
    git("checkout", "-q", "--detach");
    const detached = run("ref", ["HEAD", "123-issue"]);

    assert(
      block.includes("session-tail-gate.py") &&
        fromCheck.decision === "include" &&
        fromCheck.args === "--json check" &&
        headFirst.decision === "include" &&
        otherBranch.decision === "ask" &&
        developNotBase.decision === "ask" &&
        noDevelop.map((r) => r.decision).join() === "include,ask,include" &&
        withDevelop.map((r) => r.decision).join() === "include,ask,include" &&
        detached.decision === "ask",
      "archive-work's real Phase 1.5 gate block includes a HEAD-then-issue-branch tail, asks for another named branch, and takes the base branch from factory check, else origin/develop, else main",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function phase5Skip() {
  console.log("\narchive-work Phase 5: a factory run whose PR merged\n");
  const s5 = step(phase2, 5);
  const settled = s5.slice(s5.indexOf("**Is the run settled?**"));
  const unset = settled.slice(settled.indexOf("Anything else leaves it unset"));
  const p5 = prose(phase5);
  const skipAt = phase5.indexOf("**A settled run (`RUN_SETTLED`, Phase 2 step 5): don't ask.**");
  const askAt = phase5.indexOf("AskUserQuestion:");
  const skip = phase5.slice(skipAt, phase5.indexOf("**Otherwise ask", skipAt));
  const tools = front.split("\n").map((l) => l.trim());
  assert(
    tools.includes("- mcp__github__*") &&
      settled.includes("`.result.run.state` is `pr_open` and `.result.authorization` is not null") &&
      settled.includes("mcp__github__pull_request_read:") &&
      settled.includes("method: get") &&
      settled.includes("pullNumber: {pr_number}") &&
      /When it reports the PR merged \(`merged` is true, or `merged_at` is set\), note `RUN_SETTLED`/.test(settled) &&
      settled.includes("It is not `factory authorization`") &&
      skipAt > 0 &&
      askAt > skipAt &&
      !skip.includes("AskUserQuestion") &&
      skip.includes("go on as **Yes, archive and commit**") &&
      skip.includes("Show the destination info below and the factory-run preview") &&
      skip.includes("Phase 6.5 copies the run's artifacts and closes it with `--close`") &&
      skip.includes("Not asking: PR #{pr_number} of factory run {run_id} has merged") &&
      skill.includes("**With a factory run (Phase 2, step 5), also show:**") &&
      /bash "\$FACTORY" --json archive '\{run_id\}' --path "\$DEST" --close/.test(step(phase65, 2)) &&
      !/RUN_SETTLED/.test(phase65) &&
      p5.includes("`RUN_SETTLED`"),
    "archive-work skips Phase 5 only for a pr_open run with an active authorization whose PR merged, read through the GitHub MCP tools, and goes on as archive and commit to the run close",
  );

  const otherwise = phase5.slice(phase5.indexOf("**Otherwise ask, as always:**"), askAt);
  assert(
    otherwise.includes("a PR closed unmerged") && unset.includes("a PR still open or closed unmerged"),
    "archive-work still asks at Phase 5 for a PR closed unmerged",
  );

  assert(
    otherwise.includes("no factory run") &&
      otherwise.includes("a run with no active authorization") &&
      otherwise.includes("a PR still open") &&
      otherwise.includes("a PR read that failed") &&
      unset.includes("no run") &&
      unset.includes("no active authorization") &&
      unset.includes("a read that fails") &&
      phase5.includes('question: "Ready to archive this work?"') &&
      ['"Yes, archive and commit"', '"Archive without commit"', '"Show me what will be archived"', '"Cancel"'].every((o) =>
        phase5.slice(askAt).includes(o),
      ),
    "archive-work keeps the Phase 5 question when there is no run, no active authorization or an open PR",
  );

  const refused = step(phase65, 2).slice(step(phase65, 2).indexOf("**Refused `pr_open`:**"));
  assert(
    refused.includes("AskUserQuestion:") &&
      refused.includes('question: "PR #{pr_number} of factory run {run_id} is still open. Close the run anyway?"') &&
      refused.includes('label: "Leave the run open"') &&
      refused.includes('label: "Close as abandoned"') &&
      refused.includes("**Leave open:** `factory archive '{run_id}' --path \"$DEST\"`") &&
      refused.includes("**Close:** add `--abandon`"),
    "archive-work keeps Phase 6.5's pr_open question with both options",
  );
}

function docs() {
  console.log("\nThe docs (#123)\n");
  const design = between(read("docs/FACTORY_DESIGN.md"), "### 3.6 Plan approval", "\n## 4. ");
  const note = design.slice(design.indexOf("*As built (#123):*"));
  const cli = between(read("docs/FACTORY_CLI.md"), "### authorization", "### escalate");
  const cliNote = cli.slice(cli.indexOf("**One confirmation doesn't use it (#123).**"));
  const claude = read("CLAUDE.md")
    .split("\n")
    .find((l) => l.startsWith("**Authorized path:**")) ?? "";
  assert(
    design.includes("*As built (#123):*") &&
      note.includes("`factory status` shows its active authorization (`.result.authorization`)") &&
      note.includes("has merged") &&
      note.includes("It doesn't use `factory authorization`") &&
      note.includes("`run_deadline`") &&
      cli.includes("**One confirmation doesn't use it (#123).**") &&
      cliNote.includes("`status`'s `.result.authorization`") &&
      cliNote.includes("GitHub MCP tools") &&
      claude.includes("`archive-work` skips its Phase 5 question for a run whose PR has merged") &&
      claude.includes("not the matcher") &&
      claude.includes("(#123)"),
    "the factory docs and CLAUDE.md record that archive-work skips Phase 5 on status's active authorization and a merged PR, not the authorization matcher",
  );

  const archiving = read("docs/SESSION-ARCHIVING.md");
  const whose = between(archiving, "**Whose tail it is.**", "\n### ");
  assert(
    archiving.includes("`scripts/session-tail-gate.py` decides whether the tail is this issue's work (#123)") &&
      whose.includes("detached `HEAD` or the base branch") &&
      whose.includes("a directory below it") &&
      whose.includes("started in the main checkout") &&
      whose.includes("#89"),
    "SESSION-ARCHIVING.md describes the session-tail rule, its subdirectory handling and the main-checkout limit",
  );
}

function release() {
  console.log("\nThe release (#123)\n");
  // Minimums, not the current versions: a later release moves them (PROJECT_LORE).
  const atLeast = (v: string, min: string) => {
    const [a, b] = [v, min].map((x) => x.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  const readme = read("README.md");
  const version = /^\*\*Version:\*\* (\d+\.\d+\.\d+)$/m.exec(skill)?.[1] ?? "0.0.0";
  const current = /^\*\*Current:\*\* (\d+\.\d+\.\d+)$/m.exec(readme)?.[1] ?? "0.0.0";
  assert(
    atLeast(version, "2.8.0") &&
      /^- v2\.8\.0: .*session-tail-gate\.py.*\(#123\)$/m.test(skill) &&
      atLeast(JSON.parse(read(".claude-plugin/plugin.json")).version, "4.8.0") &&
      atLeast(current, "4.8.0") &&
      /^- 4\.8\.0 \(\d{4}-\d{2}-\d{2}\): .*\(#123\)$/m.test(readme),
    "archive-work at least 2.8.0, a plugin and README Current of at least 4.8.0, and the changelogs carry a line for #123",
  );
}

sessionTail();
gateBlockRuns();
phase5Skip();
docs();
release();
console.log("\nAll archive-work question tests passed.");
