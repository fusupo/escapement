import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseContextPath } from "./init.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "..", "scripts", "fixtures", "context-path");

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

function check(name: string, content: string, expected: string | null, expectedWarnings: number) {
  const warnings: number[] = [];
  const got = parseContextPath(content, (line) => warnings.push(line));
  assert(
    got === expected && warnings.length === expectedWarnings,
    `${name}: ${JSON.stringify(got)} with ${warnings.length} warning(s)`,
  );
}

function run() {
  console.log("parseContextPath against shared fixtures\n");

  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
  assert(names.length > 0, "fixtures found");

  for (const name of names) {
    const content = readFileSync(resolve(FIXTURES, `${name}.md`), "utf-8");
    const out = readFileSync(resolve(FIXTURES, `${name}.out`), "utf-8").replace(/\n+$/, "");
    const warn = Number(readFileSync(resolve(FIXTURES, `${name}.warn`), "utf-8").trim());
    check(name, content, out === "" ? null : out, warn);
  }

  const claudeMd = readFileSync(resolve(__dirname, "..", "CLAUDE.md"), "utf-8");
  check("escapement CLAUDE.md", claudeMd, "../escapement-ctx", 0);

  console.log("\nAll parseContextPath tests passed.");
}

run();
