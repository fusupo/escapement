// Browser tests as contract evidence (#104): the planning text that uses the
// browser-tests setting, the critic's checklist item, and the setup docs.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a heading's section, up to the next heading of the same depth. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const depth = heading.match(/^#+ /)![0];
  const next = text.indexOf(`\n${depth}`, start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

function planning() {
  console.log("Planning with browser tests\n");
  const skill = read("skills/setup-work/SKILL.md");
  const detect = section(skill, "### Phase 0.5: Detect the Factory Path");
  const contract = section(skill, "### Phase 3.2: Check the Contract [factory]");
  assert(
    detect.includes("`.result.browser_tests`") &&
      detect.includes("`{browser_tests}`") &&
      /Browser tests: \{browser_tests\}/.test(skill) &&
      /\*\*Browser tests:\*\* when `\{browser_tests\}` names a tool/.test(contract) &&
      contract.includes("is `test` evidence") &&
      contract.includes("`path::test title`") &&
      /Never `manual` for what a browser test could check/.test(contract),
    "setup-work reads browser_tests from factory check and hands it to the planner and the contract rules",
  );

  const planner = section(read("agents/scratchpad-planner.md"), "### Validation Contract (factory path only)");
  assert(
    /When the project has browser tests/.test(planner) &&
      planner.includes("`browser_tests`") &&
      planner.includes("`e2e/file.spec.ts::Describe › title`") &&
      /repository-relative/.test(planner) &&
      /keep `manual` for subjective visuals and reading prose/.test(planner),
    "the scratchpad-planner writes UI criteria as Playwright test evidence when the project has browser tests, and keeps manual for subjective visuals and reading prose",
  );

  const critic = read("prompts/factory/plan-critic.md");
  const item = critic.split("\n").find((l) => l.startsWith("- **`manual_could_be_browser_test`**:")) ?? "";
  assert(
    item.includes("`browser_tests` in `readiness.path`") &&
      /could carry out and check/.test(item) &&
      item.includes("`test` evidence") &&
      /subjective visual, reading prose/.test(item) &&
      item.includes('"no browser tests in this project"') &&
      /`browser_tests` \(the project's browser test tool, or null\)/.test(critic),
    "the plan critic prompt judges whether manual evidence could be a browser test, and reads browser_tests from the readiness",
  );
}

function docs() {
  console.log("\nThe setup, documented\n");
  const cli = read("docs/FACTORY_CLI.md");
  const setup = section(cli, "## Browser tests as evidence");
  assert(
    setup !== "" &&
      /`@playwright\/test` as a dev dependency at an exact version released at least two weeks earlier/.test(setup) &&
      setup.includes("`workers: 1`") &&
      setup.includes("`retries: 0`") &&
      /webServer[^\n]*port of its own[^\n]*temporary data folder/.test(setup) &&
      /`outputFile` inside `\$FACTORY_RESULTS_DIR`/.test(setup) &&
      /`outputDir` outside the results directory/.test(setup) &&
      setup.includes("`test-results: junit:$FACTORY_RESULTS_DIR`") &&
      /\*\*The rootDir rule\.\*\*/.test(setup) &&
      setup.includes("set `testDir` on the project, not at the top level") &&
      setup.includes("`browser-tests: playwright`") &&
      cli.includes("| `browser-tests` | `playwright`"),
    "FACTORY_CLI documents the browser test setup: pinned Playwright Test, one worker, retries 0, a per-run dev server, JUnit into the results directory, outputDir outside the results directory, the rootDir rule and the browser-tests setting",
  );
}

try {
  planning();
  docs();
  console.log("\nAll browser test checks passed.");
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
