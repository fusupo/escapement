import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseContextPath, parseEscapementSettings, resolveDbPath } from "./init.ts";

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

function runSettings() {
  console.log("\nparseEscapementSettings\n");

  const doc = [
    "# Project",
    "- **verify**: outside the section",
    "```markdown",
    "## Escapement Settings",
    "- **verify**: fenced example",
    "```",
    "## Escapement Settings",
    "- **verify**: npm test",
    "* **static**: `npm run lint`",
    "- **verify**: second occurrence",
    "- **empty**:",
    "### Subheading",
    "- **sensitive-paths**: src/auth/**, migrations/**",
    "## Next",
    "- **setup**: after the section",
  ].join("\n");
  const warnings: number[] = [];
  const s = parseEscapementSettings(doc, (line) => warnings.push(line));
  assert(s.get("verify") === "npm test", "the first occurrence inside the section wins; fences and text outside are skipped");
  assert(s.get("static") === "npm run lint", "star bullets and backticks work for any key");
  assert(s.get("empty") === "", "an empty value is kept as empty");
  assert(s.get("sensitive-paths") === "src/auth/**, migrations/**", "### subheadings stay in the section");
  assert(!s.has("setup"), "settings after the section ends are ignored");
  assert(warnings.length === 0, "only context-path outside the section warns");
  assert(!parseEscapementSettings("## Escapement Settings\n- **Verify**: x\n").has("verify"), "keys are case-sensitive");

  const claudeMd = readFileSync(resolve(__dirname, "..", "CLAUDE.md"), "utf-8");
  const own = parseEscapementSettings(claudeMd);
  assert(own.size === 1 && own.get("context-path") === "../escapement-ctx", "Escapement's CLAUDE.md has only its real context-path");
}

function runDbPath() {
  console.log("\nShared manifest location\n");

  const home = "/home/someone";
  const cwd = "/work/some-project";
  assert(
    resolveDbPath({ env: {}, home, cwd }) === "/home/someone/.local/share/escapement/manifest.db",
    "default: ~/.local/share/escapement/manifest.db",
  );
  assert(
    resolveDbPath({ env: { XDG_DATA_HOME: "/xdg" }, home, cwd }) === "/xdg/escapement/manifest.db",
    "XDG_DATA_HOME is honoured",
  );
  assert(
    resolveDbPath({ env: { XDG_DATA_HOME: "/xdg", ESCAPEMENT_MANIFEST_DIR: "/shared" }, home, cwd }) ===
      "/shared/manifest.db",
    "ESCAPEMENT_MANIFEST_DIR overrides the default",
  );
  assert(
    resolveDbPath({ dataDir: "data", env: { ESCAPEMENT_MANIFEST_DIR: "/shared" }, home, cwd }) ===
      "/work/some-project/data/manifest.db",
    "--data-dir overrides everything, relative to the cwd",
  );
  assert(
    resolveDbPath({ env: {}, home, cwd: "/work/other-project" }) === resolveDbPath({ env: {}, home, cwd }),
    "every project gets the same database",
  );

  console.log("\nAll manifest location tests passed.");
}

run();
runSettings();
runDbPath();
