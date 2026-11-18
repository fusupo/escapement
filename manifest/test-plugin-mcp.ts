// The browser server the plugin bundles for agent-assisted manual checks
// (#103): Playwright's MCP server, pinned, headless by default, local
// origins only, declared in plugin.json so only the plugin loader reads it.
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type Server = { command: string; args: string[]; env?: Record<string, string> };

/** The value after `flag` in the server's args, or undefined. */
function arg(server: Server, flag: string): string | undefined {
  const i = server.args.indexOf(flag);
  return i >= 0 ? server.args[i + 1] : undefined;
}

function run() {
  console.log("plugin: the bundled Playwright MCP server\n");
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf-8")) as {
    mcpServers?: Record<string, Server>;
  };
  const server = plugin.mcpServers?.playwright;
  assert(server !== undefined, "plugin.json declares a playwright server under mcpServers");
  if (!server) return;

  const packages = server.args.filter((a) => a.startsWith("@playwright/mcp"));
  assert(
    server.command === "npx" &&
      server.args.includes("-y") &&
      packages.length === 1 &&
      // Exactly this version: no range, tag or latest (lore: pins age two weeks).
      packages[0] === "@playwright/mcp@0.0.84",
    "the plugin's mcpServers entry runs @playwright/mcp pinned to exactly 0.0.84",
  );

  const origins = (arg(server, "--allowed-origins") ?? "").split(";").filter(Boolean).sort();
  const outputDir = arg(server, "--output-dir") ?? "";
  const headless = server.env?.PLAYWRIGHT_MCP_HEADLESS ?? "";
  assert(
    arg(server, "--browser") === "chromium" &&
      server.args.includes("--isolated") &&
      // Headless unless the operator sets ESCAPEMENT_BROWSER_HEADLESS=false: the
      // server would otherwise open a window whenever a display is available.
      headless === "${ESCAPEMENT_BROWSER_HEADLESS:-true}" &&
      !server.args.includes("--headless") &&
      // Screenshots and snapshots land outside the worktree, which validation needs clean.
      outputDir.startsWith("${TMPDIR:-/tmp}/") &&
      arg(server, "--file-paths") === "absolute" &&
      origins.join(";") === "http://127.0.0.1:*;http://localhost:*",
    "the browser server uses Playwright's own Chromium, an isolated profile, headless unless ESCAPEMENT_BROWSER_HEADLESS is false, an output dir outside the repository, and only localhost and 127.0.0.1 origins",
  );
  assert(
    !server.args.some((a) => a === "--no-sandbox" || a === "--caps" || a.startsWith("--caps=")),
    "the browser keeps its sandbox and no extra capabilities",
  );
  assert(!existsSync(join(root, ".mcp.json")), "no root .mcp.json: the repository's own sessions don't get a second, project-level browser server");

  console.log("\nAll plugin MCP tests passed.");
}

run();
