// Worktrees and context-path (#88): the skills read context-path with
// get-context-path.sh --absolute, manifest-dispatch creates worktrees with
// scripts/worktree.sh in its per-user default location, and no skill, README
// or doc tells the operator to put a worktree next to the repository. The
// README's pinned-checkout commands are also run as written.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, sh } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");
const skill = (name: string) => read(`skills/${name}/SKILL.md`);

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

/** The skills that read context-path (#88's seven readers). */
const READERS = [
  "archive-work",
  "stash-artifact",
  "setup-work",
  "manifest-bootstrap",
  "manifest-check",
  "manifest-sync",
  "manifest-dispatch",
];

/** Each `bash "…/get-context-path.sh" …` call in `text`, as the rest of its line after the script. */
function contextPathCalls(text: string): string[] {
  return [...text.matchAll(/bash\s+"[^"\n]*get-context-path\.sh"([^\n]*)/g)].map((m) => m[1]);
}

/**
 * The lines of `text` that put a worktree next to the repository, in any of
 * the ways it has been written: a path off the project root's parent, a
 * `{repo}-worktrees` directory, a `../` path given to git worktree or to
 * --plugin-dir.
 */
function besideRepository(text: string): string[] {
  const patterns = [
    /\{project-root\}\/\.\./,
    /\.\.\/\{repo/,
    /-worktrees\//,
    /-worktrees["`'\s]/,
    /project root's parent/i,
    /--plugin-dir\s+["']?\.\.\//,
    /git worktree (?:add|remove)\b[^\n]*?[\s"'](?:\.\.\/)/,
  ];
  return text.split("\n").filter((line) => patterns.some((p) => p.test(line)));
}

function procedureFiles(): string[] {
  const files = ["README.md", "CLAUDE.md"];
  for (const name of readdirSync(join(root, "skills"))) {
    if (existsSync(join(root, "skills", name, "SKILL.md"))) files.push(`skills/${name}/SKILL.md`);
  }
  for (const name of readdirSync(join(root, "docs"))) {
    if (name.endsWith(".md")) files.push(`docs/${name}`);
  }
  return files;
}

function contextPath() {
  console.log("Reading context-path\n");

  const missing: string[] = [];
  for (const name of READERS) {
    const calls = contextPathCalls(skill(name));
    if (calls.length === 0) missing.push(`${name}: no get-context-path.sh call`);
  }
  const archive = skill("archive-work");
  for (const phase of ["### Phase 1: Detect Context Path", "### Phase 4: Prepare Archive"]) {
    const calls = contextPathCalls(section(archive, phase));
    if (!calls.some((rest) => rest.startsWith(" --absolute"))) missing.push(`archive-work ${phase}: no --absolute call`);
  }
  const withoutFlag: string[] = [];
  for (const file of procedureFiles().filter((f) => f.startsWith("skills/"))) {
    for (const rest of contextPathCalls(read(file))) {
      if (!rest.startsWith(" --absolute")) withoutFlag.push(`${file}: get-context-path.sh"${rest}`);
    }
  }
  for (const m of [...missing, ...withoutFlag]) console.log(`    ${m}`);
  assert(
    missing.length === 0 && withoutFlag.length === 0,
    "every skill reads context-path with get-context-path.sh --absolute",
  );

  assert(
    !/relative to (?:the )?project root/i.test(archive),
    "archive-work no longer resolves context-path relative to the project root",
  );
  assert(
    !/relative to (?:the )?project root/i.test(skill("stash-artifact")),
    "stash-artifact no longer resolves context-path relative to the project root",
  );

  const claudeMd = read("CLAUDE.md");
  assert(
    /^@~\/escapement-ctx\/PROJECT_LORE\.md$/m.test(claudeMd) && !/^@\.\.\//m.test(claudeMd),
    "Escapement's CLAUDE.md imports its lore by a home-relative path, not a relative one",
  );
}

function dispatch() {
  console.log("\nWhere worktrees go\n");

  const text = skill("manifest-dispatch");
  const phase3 = section(text, "## Phase 3: Worktree and Branch Creation");
  assert(
    phase3.includes('scripts/worktree.sh" add "{branch-name}" origin/develop -b "{branch-name}"') &&
      phase3.includes('scripts/worktree.sh" add "{branch-name}" "{branch-name}"') &&
      phase3.includes("${XDG_DATA_HOME:-~/.local/share}/escapement/worktrees/{owner}-{repo}/{branch-name}") &&
      !/^\s*git worktree add /m.test(text) &&
      !/^\s*mkdir -p /m.test(phase3),
    "manifest-dispatch creates worktrees through worktree.sh and names the default location",
  );

  const where = "${XDG_DATA_HOME:-~/.local/share}/escapement/worktrees/{owner}-{repo}/{name}";
  assert(
    read("README.md").includes(where) && read("docs/CONTEXT_PATH.md").includes(where),
    "README and CONTEXT_PATH.md name the default worktree location",
  );
}

function beside() {
  console.log("\nNothing beside the repository\n");

  // As the layout was written before #88: dispatch's §3.1–3.2, the README's
  // pinned checkout, MANIFEST_SYSTEM_DESIGN.md's §5.4 and §5.6.
  const before = [
    "- **Worktree base**: Same directory as the project root's parent",
    "- **Worktree path**: `{project-root}/../{repo-name}-worktrees/{branch-name}`",
    'mkdir -p "{project-root}/../{repo-name}-worktrees"',
    "git worktree add --detach ../escapement-plugin develop",
    "claude --plugin-dir ../escapement-plugin",
    '1. Create a git worktree: `git worktree add "../sr-work-${node_id}" develop-ts`',
    '6. Clean up worktree: `git worktree remove "../sr-work-${node_id}"`',
  ];
  const missed = before.filter((line) => besideRepository(line).length === 0);
  for (const m of missed) console.log(`    not flagged: ${m}`);
  assert(missed.length === 0, "the beside-the-repository scan flags the layout as it was written before this change");

  const found: string[] = [];
  for (const file of procedureFiles()) {
    for (const line of besideRepository(read(file))) found.push(`${file}: ${line.trim()}`);
  }
  for (const f of found) console.log(`    ${f}`);
  assert(found.length === 0, "no skill, README or doc tells the operator to create a worktree beside the repository");
}

function readmeProcedure() {
  console.log("\nThe README's factory-on-Escapement procedure\n");

  const procedure = section(read("README.md"), "### Running the Factory on Escapement");
  const add = procedure.match(/^bash scripts\/worktree\.sh add [^\n]*$/m)?.[0] ?? "";
  const plugin = procedure.match(/^claude --plugin-dir "\$\((bash scripts\/worktree\.sh path [^)\n]*)\)"$/m)?.[1] ?? "";
  assert(
    add.includes("--detach") && add.endsWith(" develop") && plugin !== "" && !/git worktree add/.test(procedure),
    "the README's factory-on-Escapement procedure creates the pinned checkout with worktree.sh",
  );

  // Run both as written, in a stand-in for Escapement's repository (same
  // origin, a develop branch), with the default location in a temp dir.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "wt-readme-")));
  try {
    const repo = join(tmp, "escapement");
    mkdirSync(repo);
    sh("git", ["init", "-q", "-b", "develop"], repo);
    sh("git", ["remote", "add", "origin", "git@github.com:fusupo/escapement.git"], repo);
    sh("git", ["commit", "-q", "--allow-empty", "-m", "init"], repo);
    const env = { ...process.env, XDG_DATA_HOME: join(tmp, "xdg") };
    const run = (line: string) =>
      spawnSync("bash", ["-c", line.replace(/^bash scripts\//, `bash '${join(root, "scripts")}'/`)], {
        cwd: repo,
        env,
        encoding: "utf-8",
      });
    const expected = join(tmp, "xdg", "escapement", "worktrees", "fusupo-escapement", "escapement-plugin");
    const added = run(add);
    const lastLine = added.stdout.trim().split("\n").pop();
    const head = spawnSync("git", ["branch", "--show-current"], { cwd: expected, encoding: "utf-8" });
    const printed = run(plugin).stdout.trim();
    if (added.status !== 0) console.log(`    ${add}: exit ${added.status}: ${added.stderr.trim()}`);
    assert(
      added.status === 0 &&
        lastLine === expected &&
        head.status === 0 &&
        head.stdout.trim() === "" &&
        printed === expected,
      "the README's worktree.sh add command, run as written, creates a detached worktree at the default location",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function release() {
  console.log("\nRelease\n");

  const atLeast = (v: string, min: string) => {
    const [a, b] = [v, min].map((x) => x.split(".").map(Number));
    for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
    return true;
  };
  const text = skill("manifest-dispatch");
  const readme = read("README.md");
  const version = /^\*\*Version:\*\* (\d+\.\d+\.\d+)$/m.exec(text)?.[1] ?? "0.0.0";
  const current = /^\*\*Current:\*\* (\d+\.\d+\.\d+)$/m.exec(readme)?.[1] ?? "0.0.0";
  assert(
    atLeast(version, "1.1.0") &&
      /^- v1\.1\.0: .*worktree\.sh.*\(#88\)$/m.test(text) &&
      atLeast(JSON.parse(read(".claude-plugin/plugin.json")).version, "4.9.0") &&
      atLeast(current, "4.9.0") &&
      /^- 4\.9\.0 \(\d{4}-\d{2}-\d{2}\): .*\(#88\)$/m.test(readme),
    "manifest-dispatch at least 1.1.0, a plugin and README Current of at least 4.9.0, and the changelogs carry a line for #88",
  );
}

contextPath();
dispatch();
beside();
readmeProcedure();
release();
console.log("\nAll worktree and context-path skill tests passed.");
