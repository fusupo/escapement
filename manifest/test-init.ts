import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseContextPath, resolveDbPath, resolveProjectRoot } from "./init.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Shared with scripts/test-get-context-path.sh; format described at its top.
const CASES = resolve(__dirname, "..", "scripts", "fixtures", "context-path.md");
const CASE_RE = /^=== case: (.*?) \| expect: ?(.*?) \| warnings: (\d+)\s*$/;

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function check(name: string, content: string, expected: string | null, expectedWarnings: number) {
  const warnings: number[] = [];
  const got = parseContextPath(content, (line) => warnings.push(line));
  assert(
    got === expected && warnings.length === expectedWarnings,
    `${name}: ${JSON.stringify(got)} with ${warnings.length} warning(s)`,
  );
}

type Case = { name: string; expect: string | null; warnings: number; body: string[] };

function loadCases(): Case[] {
  const cases: Case[] = [];
  for (const line of readFileSync(CASES, "utf-8").split("\n")) {
    const m = line.match(CASE_RE);
    if (m) {
      cases.push({ name: m[1], expect: m[2].trim() || null, warnings: Number(m[3]), body: [] });
    } else if (cases.length > 0) {
      cases[cases.length - 1].body.push(line);
    }
  }
  return cases;
}

function run() {
  console.log("parseContextPath against shared cases\n");

  const cases = loadCases();
  assert(cases.length > 0, `${cases.length} cases loaded`);
  for (const c of cases) check(c.name, c.body.join("\n"), c.expect, c.warnings);

  // Whitespace-sensitive cases, built here so editors can't strip them.
  check("crlf", "## Escapement Settings\r\n\r\n- **context-path**: ../crlf-ctx\r\n", "../crlf-ctx", 0);
  check("trailing-whitespace", "## Escapement Settings\n\n- **context-path**: ../trailing-ctx   \t\n", "../trailing-ctx", 0);

  const claudeMd = readFileSync(resolve(__dirname, "..", "CLAUDE.md"), "utf-8");
  check("escapement CLAUDE.md", claudeMd, "../escapement-ctx", 0);

  console.log("\nAll parseContextPath tests passed.");
}

const SETTINGS = (ctx: string) => `# Project\n\n## Escapement Settings\n\n- **context-path**: ${ctx}\n`;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    stdio: "ignore",
  });
}

function runRoot() {
  console.log("\nProject root and DB path resolution\n");

  // realpath: macOS tmpdir is a symlink, and git reports resolved paths.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "manifest-root-")));
  try {
    // A git project with its own context-path, plus a subdirectory.
    const proj = join(tmp, "proj");
    mkdirSync(join(proj, "src", "deep"), { recursive: true });
    writeFileSync(join(proj, "CLAUDE.md"), SETTINGS("../proj-ctx"));
    git(proj, "init", "-q");
    git(proj, "add", "CLAUDE.md");
    git(proj, "commit", "-q", "-m", "init");
    const projDb = join(tmp, "proj-ctx", "manifest", "manifest.db");

    let loc = resolveDbPath({ cwd: proj });
    assert(loc.dbPath === projDb && !loc.inRepo, "repo root: DB under the project's context-path");

    loc = resolveDbPath({ cwd: join(proj, "src", "deep") });
    assert(loc.dbPath === projDb && loc.root === proj, "subdirectory resolves to the git toplevel");

    const wt = join(tmp, "proj-worktrees", "feature");
    git(proj, "worktree", "add", "-q", "-b", "feature", wt);
    loc = resolveDbPath({ cwd: wt });
    assert(loc.dbPath === projDb && loc.root === proj, "linked worktree resolves to the main worktree");

    // A non-git project without a context-path: in-repo DB at the cwd.
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "CLAUDE.md"), "# Plain\n\nNo settings here.\n");
    loc = resolveDbPath({ cwd: plain });
    assert(
      loc.dbPath === join(plain, "manifest", "manifest.db") && loc.inRepo,
      "no context-path: in-repo DB at {root}/manifest/manifest.db",
    );
    assert(resolveProjectRoot({ cwd: plain }) === plain, "outside git: root is the cwd");

    // --project-root wins over the cwd, relative to the cwd.
    loc = resolveDbPath({ cwd: plain, projectRoot: "../proj" });
    assert(loc.dbPath === projDb, "--project-root overrides the cwd");

    let threw = false;
    try {
      resolveDbPath({ cwd: plain, projectRoot: "../missing" });
    } catch (err) {
      threw = String(err).includes("project root does not exist");
    }
    assert(threw, "missing --project-root is an error, not a new empty manifest");

    // --data-dir wins over everything.
    loc = resolveDbPath({ cwd: proj, projectRoot: proj, dataDir: "data" });
    assert(loc.dbPath === join(proj, "data", "manifest.db") && loc.root === null, "--data-dir overrides everything");

    // An unfenced example outside the settings section is ignored with a warning.
    const doc = join(tmp, "doc");
    mkdirSync(doc);
    writeFileSync(join(doc, "CLAUDE.md"), "# Doc\n\n- **context-path**: ../wrong\n\n## Escapement Settings\n\n- **context-path**: ../doc-ctx\n");
    const warnings: string[] = [];
    loc = resolveDbPath({ cwd: doc, warn: (m) => warnings.push(m) });
    assert(
      loc.dbPath === join(tmp, "doc-ctx", "manifest", "manifest.db") &&
        warnings.length === 1 &&
        warnings[0].includes(join(doc, "CLAUDE.md")),
      "out-of-section setting ignored; warning names the project's CLAUDE.md",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log("\nAll root resolution tests passed.");
}

run();
runRoot();
