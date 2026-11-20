/**
 * Context-path from linked worktrees (#88): the runner's resolveContextPath
 * and `scripts/get-context-path.sh --absolute` against the worktree cases at
 * the top of scripts/fixtures/context-path.md (format described there).
 *
 * The main checkout lives in one temporary directory and the linked worktree
 * is nested in another, so it sits outside the repository's parent
 * directory. Every case must give the same directory from the worktree, a
 * subdirectory of it, the main checkout and a subdirectory of that, and the
 * runner and the script must agree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectContext, resolveArtifactDir, resolveContextPath } from "./factory/context.ts";
import { assert, cleanup, sh, tempDir } from "./factory/testkit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES = resolve(__dirname, "..", "scripts", "fixtures", "context-path.md");
const SCRIPT = resolve(__dirname, "..", "scripts", "get-context-path.sh");
const WORKTREE_RE = /^=== worktree: (.*?) \| expect: ?(.*?)\s*$/;

type Case = { name: string; expect: string; body: string[] };

function loadWorktreeCases(): Case[] {
  const cases: Case[] = [];
  for (const line of readFileSync(CASES, "utf-8").split("\n")) {
    if (line.startsWith("=== case: ")) break;
    const m = line.match(WORKTREE_RE);
    if (m) cases.push({ name: m[1], expect: m[2], body: [] });
    else if (cases.length > 0) cases[cases.length - 1].body.push(line);
  }
  return cases;
}

/** `get-context-path.sh --absolute` run from `cwd`: its output, "" for none. */
function script(cwd: string): string {
  return execFileSync("bash", [SCRIPT, "--absolute"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Report each mismatch, then assert there were none. */
function assertAll(failures: string[], msg: string) {
  for (const f of failures) console.log(`    mismatch: ${f}`);
  assert(failures.length === 0, msg);
}

function run() {
  console.log("Context-path from linked worktrees\n");

  const cases = loadWorktreeCases();
  assert(cases.length >= 5, "the shared fixture has at least five worktree cases");

  // The repository: its committed CLAUDE.md (what the worktree gets) sets
  // ../wrong-ctx; each case then writes the main checkout's own copy.
  const parent = join(realpathSync(tempDir("ctx-wt-")), "repo");
  const main = join(parent, "main");
  mkdirSync(join(main, "sub", "deeper"), { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], main);
  writeFileSync(join(main, "CLAUDE.md"), "## Escapement Settings\n\n- **context-path**: ../wrong-ctx\n");
  sh("git", ["add", "CLAUDE.md"], main);
  sh("git", ["commit", "-q", "-m", "init"], main);
  const wt = join(realpathSync(tempDir("ctx-far-")), "a", "b", "wt");
  sh("git", ["worktree", "add", "-q", "-b", "88-wt", wt], main);
  mkdirSync(join(wt, "sub"));
  assert(!wt.startsWith(parent + "/"), "the worktree is outside the repository's parent directory");

  const fromWorktree: string[] = [];
  const fromMain: string[] = [];
  const agree: string[] = [];
  const runner: string[] = [];

  for (const c of cases) {
    writeFileSync(join(main, "CLAUDE.md"), c.body.join("\n"));
    const expected = c.expect.replaceAll("{main}", main).replaceAll("{parent}", parent);
    const check = (bucket: string[], where: string, got: string) => {
      if (got !== expected) bucket.push(`${c.name} from ${where}: ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    };

    const scriptWt = script(wt);
    check(fromWorktree, "the worktree", scriptWt);
    check(fromWorktree, "a worktree subdirectory", script(join(wt, "sub")));
    check(fromMain, "the main checkout", script(main));
    check(fromMain, "a main checkout subdirectory", script(join(main, "sub", "deeper")));

    const resolved = resolveContextPath(wt);
    check(runner, "the worktree (resolveContextPath)", resolved ?? "");
    check(runner, "the main checkout (resolveContextPath)", resolveContextPath(main) ?? "");

    const art = resolveArtifactDir({ ctx: projectContext(wt), runId: "r1" });
    const wantArt = scriptWt ? join(scriptWt, "88-wt", "runs", "r1") : join(main, ".escapement", "runs", "88-wt", "r1");
    if ((resolved ?? "") !== scriptWt) agree.push(`${c.name}: runner ${JSON.stringify(resolved)}, script ${JSON.stringify(scriptWt)}`);
    if (art.dir !== wantArt) agree.push(`${c.name}: artifact dir ${art.dir}, want ${wantArt}`);
  }

  assertAll(
    fromWorktree,
    "get-context-path.sh --absolute run from a worktree outside the repository's parent directory prints the main checkout's context directory",
  );
  assertAll(
    fromMain,
    "get-context-path.sh --absolute run from the main checkout's root and from a subdirectory prints the same context directory",
  );
  assertAll(agree, "the runner and get-context-path.sh --absolute agree on the context directory from the same worktree");
  assertAll(runner, "resolveContextPath resolves every worktree case in the shared fixture from the main checkout");

  // Outside git the directory itself stands in for the main checkout.
  const plain = realpathSync(tempDir("ctx-plain-"));
  writeFileSync(join(plain, "CLAUDE.md"), "## Escapement Settings\n\n- **context-path**: ../plain-ctx\n");
  assert(resolveContextPath(plain) === join(dirname(plain), "plain-ctx"), "outside git, resolveContextPath resolves against the directory itself");
}

try {
  run();
  console.log("\nAll context-path worktree tests passed.");
} finally {
  cleanup();
}
