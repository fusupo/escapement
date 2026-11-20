// The session-tail gate (#123): scripts/session-tail-gate.py decides
// whether archive-work includes a session-log slice without asking. Each
// case writes a transcript slice and runs the real script.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(repoRoot, "scripts", "session-tail-gate.py");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "session-tail-gate-")));
// The worktree the archive runs in, a subdirectory of it, a worktree nested
// inside it (its own .git file) and a sibling worktree next to it.
const root = join(tmp, "wt");
const sub = join(root, "manifest", "factory");
const nested = join(root, ".worktrees", "other");
const sibling = join(tmp, "wt-sibling");
for (const d of [sub, nested, sibling]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
writeFileSync(join(nested, ".git"), "gitdir: /elsewhere/other\n");

const ISSUE = "123-archive-work";
const BASE = "develop";

type Entry = [branch: string, cwd?: string];
let n = 0;

/** Run the gate on a slice made of these entries; returns its decision JSON. */
function gate(entries: (Entry | string)[], opts: { branch?: string; base?: string; root?: string } = {}) {
  const file = join(tmp, `slice-${++n}.jsonl`);
  const lines = entries.map((e, i) => {
    if (typeof e === "string") return e; // a raw line, such as one that isn't JSON
    const [gitBranch, cwd = root] = e;
    return JSON.stringify({ type: "user", gitBranch, cwd, timestamp: `2026-11-19T10:00:${String(i).padStart(2, "0")}Z` });
  });
  writeFileSync(file, lines.join("\n") + "\n");
  const r = spawnSync(
    "python3",
    ["-I", SCRIPT, file, "--branch", opts.branch ?? ISSUE, "--base", opts.base ?? BASE, "--root", opts.root ?? root],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`FAIL: session-tail-gate exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as { decision: string; reason: string; branches: Record<string, number>; first: string; last: string };
}
const decision = (entries: (Entry | string)[], opts = {}) => gate(entries, opts).decision;

try {
  console.log("session-tail-gate: what counts as this issue's work\n");

  const headFirst = gate([["HEAD"], ["HEAD"], [ISSUE], [ISSUE]]);
  assert(
    headFirst.decision === "include" &&
      headFirst.reason === "setup_before_issue_branch" &&
      JSON.stringify(headFirst.branches) === JSON.stringify({ HEAD: 2, [ISSUE]: 2 }) &&
      headFirst.first === "2026-11-19T10:00:00Z" &&
      headFirst.last === "2026-11-19T10:00:03Z",
    "session-tail-gate includes a tail whose only other branch is a detached HEAD before the issue branch, in the same worktree",
  );

  assert(
    decision([[BASE], [BASE], [ISSUE]]) === "include" &&
      decision([[BASE], [ISSUE]], { base: "main" }) === "ask" &&
      decision([["main"], [ISSUE]], { base: "main" }) === "include",
    "session-tail-gate includes a tail whose entries before the issue branch are on the base branch, in the same worktree",
  );

  assert(
    decision([["HEAD"], [BASE], ["HEAD"], [ISSUE]]) === "include" && decision([[ISSUE], [ISSUE]]) === "include",
    "session-tail-gate includes a tail of HEAD and base-branch entries mixed before the issue branch, and one only on the issue branch",
  );

  const before = gate([["HEAD"], ["42-other"], [ISSUE]]);
  const between = gate([["HEAD"], [ISSUE], ["42-other"], [ISSUE]]);
  const after = gate([[ISSUE], ["42-other"]]);
  const otherOnly = gate([["42-other"], [ISSUE]]);
  assert(
    [before, between, after, otherOnly].every((g) => g.decision === "ask" && g.reason === "other_branch") &&
      JSON.stringify(before.branches) === JSON.stringify({ HEAD: 1, "42-other": 1, [ISSUE]: 1 }),
    "session-tail-gate asks when another named branch appears before, between or after the issue branch",
  );

  const headAfter = gate([["HEAD"], [ISSUE], ["HEAD"]]);
  const baseAfter = gate([[ISSUE], [BASE], [ISSUE]]);
  const absent = gate([["HEAD"], [BASE]]);
  assert(
    headAfter.decision === "ask" &&
      headAfter.reason === "head_or_base_after_issue_branch" &&
      baseAfter.decision === "ask" &&
      baseAfter.reason === "head_or_base_after_issue_branch" &&
      absent.decision === "ask" &&
      absent.reason === "issue_branch_absent",
    "session-tail-gate asks when HEAD or base-branch entries come after the issue branch started, or the issue branch never appears",
  );

  const outside = gate([["HEAD", sibling], [ISSUE]]);
  const parent = gate([["HEAD", tmp], [ISSUE]]);
  const inNested = gate([["HEAD", nested], [ISSUE]]);
  assert(
    decision([["HEAD", sub], [BASE, join(root, "manifest")], [ISSUE, root]]) === "include" &&
      decision([["HEAD", join(root, "not", "there", "anymore")], [ISSUE]]) === "include" &&
      decision([["HEAD", sub], [ISSUE, sub]], { root: sub + "/" }) === "include" &&
      [outside, parent, inNested].every((g) => g.decision === "ask" && g.reason === "outside_worktree") &&
      decision([["HEAD", `${root}-sibling`], [ISSUE]]) === "ask",
    "session-tail-gate treats a subdirectory of the worktree root as the same worktree and asks for a cwd outside it",
  );

  assert(
    decision([["HEAD"], [ISSUE, sibling]]) === "include" && decision([["HEAD", ""], [ISSUE]]) === "include",
    "session-tail-gate checks the cwd only before the issue branch, and only where an entry records one",
  );

  console.log("\nsession-tail-gate: no issue branch to anchor on\n");

  const onBase = gate([[ISSUE], [BASE]], { branch: BASE });
  const onBaseOnly = gate([[BASE], [BASE]], { branch: BASE });
  const detached = gate([["HEAD"], [ISSUE]], { branch: "" });
  assert(
    onBase.decision === "ask" &&
      onBase.reason === "no_issue_branch" &&
      onBaseOnly.decision === "include" &&
      detached.decision === "ask" &&
      detached.reason === "no_issue_branch",
    "session-tail-gate falls back to the old rule (every entry on the current branch) on the base branch or a detached HEAD",
  );

  console.log("\nsession-tail-gate: input\n");

  const messy = gate([
    "not json",
    "[1, 2]",
    JSON.stringify({ type: "summary", timestamp: "2026-11-19T09:59:59Z" }),
    ["HEAD"],
    [ISSUE],
    '{"truncated": ',
  ]);
  const empty = gate([]);
  assert(
    messy.decision === "include" &&
      messy.first === "2026-11-19T09:59:59Z" &&
      JSON.stringify(messy.branches) === JSON.stringify({ HEAD: 1, [ISSUE]: 1 }) &&
      empty.decision === "include" &&
      empty.first === "-" &&
      empty.last === "-",
    "session-tail-gate skips lines that aren't JSON entries and ignores entries without a gitBranch",
  );

  const missing = spawnSync("python3", ["-I", SCRIPT, join(tmp, "missing.jsonl"), "--branch", ISSUE, "--base", BASE, "--root", root], {
    encoding: "utf-8",
  });
  const noRoot = spawnSync("python3", ["-I", SCRIPT, join(tmp, "slice-1.jsonl"), "--branch", ISSUE, "--base", BASE], { encoding: "utf-8" });
  const emptyBase = spawnSync("python3", ["-I", SCRIPT, join(tmp, "slice-1.jsonl"), "--branch", ISSUE, "--base", "", "--root", root], {
    encoding: "utf-8",
  });
  assert(
    missing.status === 2 && missing.stdout === "" && noRoot.status === 2 && emptyBase.status === 2,
    "session-tail-gate exits 2 with no decision for a missing file or a missing or empty argument",
  );

  console.log("\nAll session-tail-gate tests passed.");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
