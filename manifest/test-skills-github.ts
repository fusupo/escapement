// Skills act on GitHub as the AI agent (#80, FACTORY_DESIGN.md §4.8).
//
// The GitHub MCP server is authenticated as the agent account; the gh CLI is
// logged in as the operator. So skills, agents and agent prompts must never
// call gh, and must name only GitHub MCP tools the server actually has (a
// skill that can't find its tool drifts back to gh). Pushes go through
// `factory push`, commits carry the `factory agent` identity, and the docs
// say so. These are static checks of the shipped text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

/** Every file under dir (relative to the repo root), recursively. */
function filesUnder(dir: string, keep: (rel: string) => boolean = () => true): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (keep(relative(ROOT, p))) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

/**
 * The GitHub MCP server's tools (github/github-mcp-server, the server the
 * operator connects as the agent). Its older per-action tools (get_issue,
 * create_issue, get_pull_request_files, create_and_submit_pull_request_review,
 * …) were consolidated into issue_read, issue_write, pull_request_read and
 * pull_request_review_write. Update this list when the server changes.
 */
export const GITHUB_MCP_TOOLS = new Set([
  "add_comment_to_pending_review",
  "add_issue_comment",
  "add_reply_to_pull_request_comment",
  "assign_copilot_to_issue",
  "create_branch",
  "create_or_update_file",
  "create_pull_request",
  "create_repository",
  "delete_file",
  "fork_repository",
  "get_commit",
  "get_file_contents",
  "get_label",
  "get_latest_release",
  "get_me",
  "get_release_by_tag",
  "get_tag",
  "get_team_members",
  "get_teams",
  "issue_read",
  "issue_write",
  "list_branches",
  "list_commits",
  "list_issue_types",
  "list_issues",
  "list_pull_requests",
  "list_releases",
  "list_tags",
  "merge_pull_request",
  "pull_request_read",
  "pull_request_review_write",
  "push_files",
  "request_copilot_review",
  "search_code",
  "search_issues",
  "search_pull_requests",
  "search_repositories",
  "search_users",
  "sub_issue_write",
  "update_pull_request",
  "update_pull_request_branch",
]);

/**
 * `gh` as a word: the CLI named or called. Not part of a longer identifier
 * (gh_failed, ESCAPEMENT_AGENT_GH_TOKEN, github) or a path (gh.git).
 */
const GH_WORD = /(?<![\w./-])gh(?![\w.-])/;
/** gh run as a command, in a shell script. */
const GH_COMMAND = /(?:^|[\s;&|(`$])gh\s+(?:pr|issue|api|auth|repo|release|run|workflow|search|label|gist|secret|browse)\b/;

function unknownMcpTools(text: string): string[] {
  return [...text.matchAll(/mcp__github__([a-z_]+)/g)].map((m) => m[1]).filter((t) => !GITHUB_MCP_TOOLS.has(t));
}

/** The `tools:` list of a markdown file's YAML frontmatter. */
function frontmatterTools(text: string): string[] {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const block = fm[1].match(/^tools:\n((?:[ \t]+-.*\n?)*)/m);
  return block ? block[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
}

/** The text of a `### {heading}` section, up to the next heading of level 1–3. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`### ${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + 4 + heading.length);
  const end = rest.search(/\n#{1,3} /);
  return end < 0 ? rest : rest.slice(0, end);
}

function run() {
  const skillFiles = [
    ...filesUnder("skills"),
    ...filesUnder("agents", (p) => p.endsWith(".md")),
    ...filesUnder("prompts", (p) => p.endsWith(".md")),
  ];

  console.log("The detectors\n");
  assert(
    ["gh pr create --title x", "or `gh issue view 42`", "Ensure gh CLI is installed", "  - Bash:gh *"].every((l) => GH_WORD.test(l)),
    "the gh detector catches gh commands and the gh CLI named in prose",
  );
  assert(
    ["`gh_failed`", "ESCAPEMENT_AGENT_GH_TOKEN", "the GitHub MCP tools", "mcp__github__issue_read", "/tmp/gh.git"].every((l) => !GH_WORD.test(l)),
    "it ignores error codes, variables, GitHub and paths",
  );
  assert(
    unknownMcpTools("mcp__github__get_issue mcp__github__issue_read mcp__github__*").join() === "get_issue",
    "the tool check rejects a removed tool name and accepts current ones and the wildcard",
  );

  console.log("\nSkills, agents and prompts\n");
  assert(skillFiles.filter((f) => f.startsWith("skills/") && f.endsWith("SKILL.md")).length >= 15, "every skill is scanned");

  const ghCalls = skillFiles.flatMap((f) =>
    read(f)
      .split("\n")
      .map((line, i) => ({ f, n: i + 1, line }))
      .filter((x) => GH_WORD.test(x.line)),
  );
  if (ghCalls.length) console.error(ghCalls.map((x) => `    ${x.f}:${x.n}: ${x.line.trim()}`).join("\n"));
  assert(ghCalls.length === 0, "no skill, agent or prompt file calls gh");

  const ghTools = skillFiles
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => frontmatterTools(read(f)).filter((t) => /^Bash:\s*gh\b/.test(t)).map((t) => `${f}: ${t}`));
  if (ghTools.length) console.error(ghTools.map((x) => `    ${x}`).join("\n"));
  assert(ghTools.length === 0, "no skill lists Bash:gh in its frontmatter tools");

  const unknown = skillFiles.flatMap((f) => unknownMcpTools(read(f)).map((t) => `${f}: mcp__github__${t}`));
  if (unknown.length) console.error(unknown.map((x) => `    ${x}`).join("\n"));
  assert(unknown.length === 0, "every GitHub MCP tool a skill names exists on the GitHub MCP server");

  const usesGithub = skillFiles.filter((f) => f.endsWith("SKILL.md") && /mcp__github__[a-z_]/.test(read(f)));
  const withoutTools = usesGithub.filter((f) => !frontmatterTools(read(f)).includes("mcp__github__*"));
  assert(usesGithub.length > 0 && withoutTools.length === 0, `skills that call GitHub MCP tools list mcp__github__* (${withoutTools.join(", ") || "all do"})`);

  console.log("\nThe remaining gh use\n");
  const scripts = [...filesUnder("hooks"), ...filesUnder("scripts", (p) => !/\/test-|\/fixtures\//.test(p))].filter((f) => /\.(sh|py)$/.test(f));
  const scriptCalls = scripts.filter((f) => read(f).split("\n").some((l) => !l.trim().startsWith("#") && GH_COMMAND.test(l)));
  assert(scriptCalls.length === 0, `hooks and scripts don't call gh either (${scriptCalls.join(", ") || "none"})`);
  const runner = filesUnder("manifest/factory", (p) => p.endsWith(".ts") && !p.endsWith("testkit.ts") && !p.endsWith("fixtures.ts"));
  const spawnsGh = runner.filter((f) => /execFileSync\("gh"/.test(read(f)));
  assert(
    spawnsGh.join() === "manifest/factory/github.ts" && /GH_TOKEN: opts\.token/.test(read("manifest/factory/github.ts")),
    "the runner runs gh in one place, github.ts, always with the agent token as GH_TOKEN",
  );

  console.log("\nPushes, PRs and commits as the agent\n");
  const createPr = read("skills/create-pr/SKILL.md");
  const phase6 = section(createPr, "Phase 6: Create Pull Request");
  const pushAt = phase6.indexOf('scripts/factory.sh" --json push');
  const fallbackAt = phase6.indexOf("`no_agent_token`");
  const gitPushes = [...phase6.matchAll(/git push/g)].map((m) => m.index!);
  assert(
    pushAt >= 0 &&
      phase6.includes("mcp__github__create_pull_request(") &&
      fallbackAt > pushAt &&
      gitPushes.length === 1 &&
      gitPushes[0] > fallbackAt &&
      frontmatterTools(createPr).includes("mcp__github__*"),
    "create-pr opens the PR with the GitHub MCP tools and pushes with factory push",
  );
  const doWork = read("skills/do-work/SKILL.md");
  assert(/scripts\/factory\.sh" --json push/.test(section(doWork, "Phase 4: Continuous Sync")), "do-work's push reminder pushes with factory push");
  assert(
    /mcp__github__list_pull_requests/.test(read("skills/manifest-sync/SKILL.md")) &&
      /mcp__github__pull_request_read\(method: "get_files"/.test(read("skills/manifest-sync/SKILL.md")) &&
      /mcp__github__issue_read/.test(section(read("skills/validate-work/SKILL.md"), "Phase 3: Review")),
    "manifest-sync and validate-work read GitHub through the MCP tools",
  );

  const commit = read("skills/commit-changes/SKILL.md");
  const identity = section(commit, "Phase 0.5: Commit Identity (plain path)");
  const execute = section(commit, "Phase 5: Execute Commit");
  assert(
    /scripts\/factory\.sh" --json agent/.test(identity) &&
      identity.includes("`no_agent_token`") &&
      identity.includes("Committing as the operator") &&
      identity.includes("`agent_env_permissions`") &&
      execute.includes('git -c user.name="{name}" -c user.email="{email}" commit'),
    "commit-changes commits with the factory agent identity when one is configured",
  );

  console.log("\nThe docs\n");
  const claude = read("CLAUDE.md");
  const design = read("docs/FACTORY_DESIGN.md");
  const cli = read("docs/FACTORY_CLI.md");
  const rule = section(claude, "GitHub as the Agent");
  assert(
    rule.includes("GitHub MCP tools") &&
      rule.includes("`factory push`") &&
      rule.includes("`factory agent`") &&
      rule.includes("`no_agent_token`") &&
      rule.includes("runner") &&
      design.includes("*As built (#80)") &&
      design.includes("`factory push`") &&
      design.includes("Without an agent identity") &&
      cli.includes("### push") &&
      ![claude, design].some((t) => /converted in #80|converting the remaining `gh` calls/.test(t)),
    "docs state the MCP rule, factory push and agent commit authorship",
  );

  console.log("\nAll skills-on-GitHub checks passed.");
}

try {
  run();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
