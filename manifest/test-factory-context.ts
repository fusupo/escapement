import { existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectContext, resolveArtifactDir, repoName, defaultTargetRef, excludePatterns } from "./factory/context.ts";
import { atomicWrite, parseDuration } from "./factory/util.ts";
import { assert, throws, tempDir, cleanup, sh, makeRepo } from "./factory/testkit.ts";

function run() {
  console.log("Factory project context\n");

  {
    const root = realpathSync(makeRepo({ branch: "42-thing", origin: "git@github.com:acme/widgets.git" }));
    mkdirSync(join(root, "sub"));
    const ctx = projectContext(undefined, join(root, "sub"));
    assert(ctx.worktreePath === root, "worktree is the git toplevel of the cwd");
    assert(ctx.mainRoot === root, "main root of a plain checkout is itself");
    assert(ctx.repo === "acme/widgets", "repo comes from an ssh origin URL");
    assert(ctx.branch === "42-thing", "branch is the current branch");

    const other = tempDir();
    const viaFlag = projectContext(root, other);
    assert(viaFlag.worktreePath === root, "--project-root works from any cwd");

    const wt = join(tempDir(), "wt");
    sh("git", ["worktree", "add", "-q", "-b", "43-other", wt], root);
    const wctx = projectContext(wt, other);
    assert(wctx.worktreePath === realpathSync(wt), "a linked worktree is its own worktree path");
    assert(wctx.mainRoot === root, "a linked worktree's main root is the main checkout");
    assert(wctx.branch === "43-other", "a linked worktree reports its own branch");
  }

  {
    const root = makeRepo({ origin: "https://github.com/acme/gadgets" });
    assert(repoName(root) === "acme/gadgets", "repo comes from an https origin URL without .git");
    const bare = makeRepo();
    assert(repoName(bare) === bare.split("/").pop(), "repo falls back to the directory name");
    assert(defaultTargetRef(root) === "main", "target ref defaults to main without origin/develop");
  }

  {
    const outside = tempDir();
    throws(() => projectContext(undefined, outside), /not_a_repo/, "outside a repo is an error");
    throws(() => projectContext(join(outside, "missing"), outside), /bad_project_root/, "a missing --project-root is an error");
    const root = makeRepo();
    sh("git", ["checkout", "-q", "--detach"], root);
    throws(() => projectContext(root), /detached_head/, "a detached HEAD is an error");
  }

  console.log("\nArtifact directory\n");

  {
    const root = realpathSync(makeRepo({ branch: "42-x", claudeMd: "## Escapement Settings\n\n- **context-path**: ../ctx\n" }));
    const ctx = projectContext(root);
    const r = resolveArtifactDir({ ctx, runId: "esc#42-r1" });
    assert(r.source === "context-path", "context-path is used when set");
    assert(r.dir === resolve(root, "../ctx/42-x/runs/esc#42-r1"), "context-path layout is {ctx}/{branch}/runs/{run_id}");

    const flag = resolveArtifactDir({ ctx, runId: "r1", artifactDir: "out", cwd: "/somewhere" });
    assert(flag.source === "flag" && flag.dir === "/somewhere/out/r1", "--artifact-dir wins and is relative to the cwd");
  }

  {
    const root = realpathSync(makeRepo({ branch: "7-y", claudeMd: "# no settings here\n" }));
    const ctx = projectContext(root);
    const r = resolveArtifactDir({ ctx, runId: "r1" });
    assert(r.source === "in-repo", "no context-path falls back to the project directory");
    assert(r.dir === join(root, ".escapement/runs/7-y/r1"), "in-repo layout is .escapement/runs/{branch}/{run_id}");
    const exclude = readFileSync(join(root, ".git/info/exclude"), "utf-8");
    assert(exclude.includes("/.escapement/"), ".escapement/ is added to .git/info/exclude");
    resolveArtifactDir({ ctx, runId: "r2" });
    const again = readFileSync(join(root, ".git/info/exclude"), "utf-8");
    assert(again.split("/.escapement/").length === 2, "the exclude entry is added only once");

    atomicWrite(join(r.dir, "probe.txt"), "x");
    assert(sh("git", ["status", "--porcelain"], root) === "", "artifacts in .escapement/ leave the tree clean");

    const wt = join(tempDir(), "wt");
    sh("git", ["worktree", "add", "-q", "-b", "8-z", wt], root);
    const w = resolveArtifactDir({ ctx: projectContext(wt), runId: "r1" });
    assert(w.dir === join(root, ".escapement/runs/8-z/r1"), "a worktree's in-repo artifacts go in the main checkout");
  }

  console.log("\nHost working-file excludes\n");

  {
    const root = realpathSync(makeRepo());
    const excludeFile = join(root, ".git/info/exclude");
    writeFileSync(excludeFile, "*.swp"); // no trailing newline
    writeFileSync(join(root, "SCRATCHPAD_9.md"), "plan\n");
    writeFileSync(join(root, "SESSION_LOG_1.jsonl"), "{}\n");
    const r = excludePatterns(root, ["SCRATCHPAD_*", "SESSION_LOG_*", "AGENT_CONSTRAINTS.md", "SCRATCHPAD_*"]);
    assert(r.path === excludeFile, "patterns go to the repository's info/exclude");
    assert(
      r.added.join(",") === "SCRATCHPAD_*,SESSION_LOG_*,AGENT_CONSTRAINTS.md" && r.present.length === 0,
      "each new pattern is added once, in order",
    );
    const text = readFileSync(excludeFile, "utf-8");
    assert(text.startsWith("*.swp\n# escapement working files\nSCRATCHPAD_*\n"), "existing lines are kept and a newline is supplied");
    assert(sh("git", ["status", "--porcelain"], root) === "", "excluded working files leave the tree clean");

    const again = excludePatterns(root, ["SESSION_LOG_*", "*.swp", "NOTES.md"]);
    assert(again.added.join(",") === "NOTES.md" && again.present.join(",") === "SESSION_LOG_*,*.swp", "existing patterns are reported present");
    assert(readFileSync(excludeFile, "utf-8").split("SESSION_LOG_*").length === 2, "and not added again");

    const wt = join(tempDir(), "wt");
    sh("git", ["worktree", "add", "-q", "-b", "9-w", wt], root);
    const w = excludePatterns(wt, ["SCRATCHPAD_*"]);
    assert(w.path === excludeFile && w.present.join(",") === "SCRATCHPAD_*", "a linked worktree shares the main checkout's exclude file");
    writeFileSync(join(wt, "SCRATCHPAD_9.md"), "plan\n");
    assert(sh("git", ["status", "--porcelain"], wt) === "", "so its working files are excluded too");

    for (const bad of ["", "  ", "# note", "!keep.md", "a\nb"]) {
      throws(() => excludePatterns(root, [bad]), /bad_pattern/, `refuses ${JSON.stringify(bad)}`);
    }
    throws(() => excludePatterns(root, []), /usage/, "needs at least one pattern");
  }

  console.log("\nHelpers\n");

  {
    assert(parseDuration("15m") === 900_000, "15m");
    assert(parseDuration("2h") === 7_200_000, "2h");
    assert(parseDuration("500ms") === 500, "500ms");
    assert(parseDuration("1.5s") === 1500, "1.5s");
    throws(() => parseDuration("10"), /bad_duration/, "a bare number is rejected");

    const dir = tempDir();
    const file = join(dir, "a", "b.json");
    atomicWrite(file, "one");
    atomicWrite(file, "two");
    assert(readFileSync(file, "utf-8") === "two", "atomicWrite replaces content and creates parents");
    assert(existsSync(file) && sh("ls", ["-A", join(dir, "a")], dir) === "b.json", "atomicWrite leaves no temp files");
  }

  console.log("\nAll factory context tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
