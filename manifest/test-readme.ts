// The README stays honest (#91).
//
// README.md is the plugin's public description, so it drifts silently when
// skills are added or renamed, files move, or diagrams go stale. These are
// static checks: every skill directory is listed, no retired names, every
// relative link resolves, the four Mermaid diagrams are there, and no old
// PNG diagram is left in the repo. Each rule is first run against a fixture
// README in scripts/fixtures/readme/ that must trip it (and only it), so
// the suite proves it can fail, then against the real README.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTORY_KEYS } from "./factory/settings.ts";
import { assert, cleanup, tempDir } from "./factory/testkit.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(ROOT, "scripts/fixtures/readme");

/** Names the README must never use: retired skills and the project's old name. */
export const RETIRED_NAMES = ["issue-setup", "work-session", "muleteer"] as const;
/** The overview, the workflow phases, the factory path and the manifest loop. */
export const MIN_DIAGRAMS = 4;

export type Rule = "skill" | "retired" | "link" | "mermaid";
export type Violation = { rule: Rule; detail: string };

/** Every directory under skills/, which is every skill the plugin ships. */
export function skillDirs(root: string): string[] {
  const dir = join(root, "skills");
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isDirectory())
    .sort();
}

/** The text with fenced code blocks blanked out, so their contents aren't read as links. */
function withoutFences(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null && m) {
      fence = m[1][0];
      out.push("");
    } else if (fence !== null) {
      if (m && m[1][0] === fence) fence = null;
      out.push("");
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function mermaidCount(text: string): number {
  return (text.match(/^\s*(`{3,}|~{3,})\s*mermaid\s*$/gm) ?? []).length;
}

/** Relative link targets: inline `[x](t)`, images `![x](t)` and reference definitions `[x]: t`. */
export function relativeLinks(text: string): string[] {
  const body = withoutFences(text);
  const targets: string[] = [];
  for (const m of body.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) targets.push(m[1]);
  for (const m of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) targets.push(m[1]);
  return targets.filter((t) => !t.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(t));
}

/**
 * The README's violations. `skills` are the skill directory names; `exists`
 * answers for a path already resolved against the README's directory.
 */
export function checkReadme(
  text: string,
  opts: { skills: readonly string[]; readmeDir: string; exists: (path: string) => boolean },
): Violation[] {
  const out: Violation[] = [];
  for (const name of opts.skills) {
    if (!text.includes(`\`${name}\``)) out.push({ rule: "skill", detail: `skill \`${name}\` is not listed` });
  }
  const lower = text.toLowerCase();
  for (const name of RETIRED_NAMES) {
    if (lower.includes(name)) out.push({ rule: "retired", detail: `retired name "${name}"` });
  }
  for (const target of relativeLinks(text)) {
    const path = decodeURI(target.replace(/[#?].*$/, ""));
    if (!path) continue;
    if (!opts.exists(resolve(opts.readmeDir, path))) out.push({ rule: "link", detail: `broken link ${target}` });
  }
  const diagrams = mermaidCount(text);
  if (diagrams < MIN_DIAGRAMS) {
    out.push({ rule: "mermaid", detail: `${diagrams} mermaid diagram(s), at least ${MIN_DIAGRAMS} expected` });
  }
  return out;
}

/** Old PNG workflow diagrams anywhere under root, skipping .git, node_modules and test fixtures. */
export function findWorkflowPngs(root: string): string[] {
  const found: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const rel = relative(root, p);
      if (statSync(p).isDirectory()) {
        if (name === ".git" || name === "node_modules" || rel === join("scripts", "fixtures")) continue;
        walk(p);
      } else if (/^workflow.*\.png$/i.test(name)) {
        found.push(rel);
      }
    }
  };
  walk(root);
  return found.sort();
}

/** Check a fixture README against two made-up skills, resolving links from the fixture directory. */
function checkFixture(name: string): Violation[] {
  const text = readFileSync(join(FIXTURES, name), "utf-8");
  return checkReadme(text, { skills: ["alpha-skill", "beta-skill"], readmeDir: FIXTURES, exists: existsSync });
}

const only = (v: Violation[], rule: Rule, count = 1) => v.length === count && v.every((x) => x.rule === rule);

function show(v: Violation[]): void {
  for (const x of v) console.error(`    ${x.rule}: ${x.detail}`);
}

function run(): void {
  console.log("\nThe check, against fixtures\n");

  const good = checkFixture("good.md");
  show(good);
  assert(good.length === 0, "accepts a good fixture README");

  const missing = checkFixture("missing-skill.md");
  assert(
    only(missing, "skill") && missing[0].detail.includes("`beta-skill`"),
    "rejects a README that omits a skill directory",
  );

  const retired = checkFixture("retired-name.md");
  assert(
    only(retired, "retired", 2) &&
      retired.some((x) => x.detail.includes("issue-setup")) &&
      retired.some((x) => x.detail.includes("work-session")),
    "rejects retired names issue-setup and work-session",
  );

  const old = checkFixture("muleteer.md");
  assert(only(old, "retired") && old[0].detail.includes("muleteer"), "rejects the word muleteer in the README");

  const link = checkFixture("broken-link.md");
  assert(only(link, "link") && link[0].detail.includes("docs/NOPE.md"), "rejects a broken relative link");

  const three = checkFixture("three-diagrams.md");
  assert(only(three, "mermaid"), "rejects a README with fewer than four mermaid diagrams");

  const repo = tempDir("readme-test-");
  mkdirSync(join(repo, "docs/img"), { recursive: true });
  mkdirSync(join(repo, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(repo, "scripts/fixtures"), { recursive: true });
  writeFileSync(join(repo, "logo.png"), "");
  writeFileSync(join(repo, "node_modules/pkg/workflow.png"), "");
  writeFileSync(join(repo, "scripts/fixtures/workflow.png"), "");
  const clean = findWorkflowPngs(repo);
  writeFileSync(join(repo, "workflow.png"), "");
  writeFileSync(join(repo, "docs/img/workflow_review.png"), "");
  const leftover = findWorkflowPngs(repo);
  assert(
    clean.length === 0 && leftover.join(",") === ["docs/img/workflow_review.png", "workflow.png"].join(","),
    "rejects a leftover workflow png",
  );

  console.log("\nThe real README\n");
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const violations = checkReadme(readme, { skills: skillDirs(ROOT), readmeDir: dirname(join(ROOT, "README.md")), exists: existsSync });
  show(violations);

  assert(!violations.some((v) => v.rule === "retired"), "real README uses no retired name");
  assert(mermaidCount(readme) >= MIN_DIAGRAMS, "real README has at least four mermaid diagrams");
  const pngs = findWorkflowPngs(ROOT);
  for (const p of pngs) console.error(`    leftover: ${p}`);
  assert(pngs.length === 0, "no workflow png is left in the repo");
  assert(
    !/\bbeing built\b/i.test(readme) && !/until \[?#58/i.test(readme),
    "real README does not describe the factory runner as being built",
  );
  const unnamed = [...FACTORY_KEYS, "context-path"].filter((k) => !readme.includes(`\`${k}\``));
  for (const k of unnamed) console.error(`    settings key not named: ${k}`);
  assert(unnamed.length === 0, "real README names every factory settings key");
  assert(violations.length === 0, "real README passes every rule");

  console.log("\nAll README checks passed.");
}

try {
  run();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  cleanup();
}
