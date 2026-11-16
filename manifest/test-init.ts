import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseContextPath } from "./init.ts";

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

run();
