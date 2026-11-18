// Browser tests as contract evidence (#104): the planning text that uses the
// browser-tests setting, the critic's checklist item, and the setup docs.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

/** The text of a heading's section, up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const depth = heading.match(/^#+/)![0].length;
  const rest = text.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${depth}} `));
  return text.slice(start, next < 0 ? undefined : start + heading.length + next);
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

  const example = section(cli, "### Worked example: hackensack-next");
  assert(
    setup.includes(example) &&
      example.includes("fusupo/hackensack-next") &&
      /quoted unchanged from its `main` at `[0-9a-f]{7,}`/.test(example) &&
      example.includes('"@playwright/test": "1.64.1",') &&
      example.includes("export default defineConfig({") &&
      example.includes("{ name: 'chromium', testDir: 'e2e',") &&
      example.includes("['junit', { outputFile: join(resultsDir, 'playwright.xml') }]") &&
      example.includes("- **test-results**: junit:$FACTORY_RESULTS_DIR") &&
      example.includes("- **browser-tests**: playwright") &&
      /- \*\*verify\*\*: .*npx vitest run.*npx playwright test/.test(example),
    "FACTORY_CLI quotes hackensack-next as the worked example",
  );

  const readme = read("README.md");
  const intro = section(readme, "### Browser tests as evidence");
  assert(
    intro !== "" &&
      /browser tests instead of manual checks/.test(intro) &&
      intro.includes("ordinary `test` evidence") &&
      intro.includes("](docs/FACTORY_CLI.md#browser-tests-as-evidence)") &&
      intro.includes("Its worked example is fusupo/hackensack-next") &&
      intro.includes("](docs/FACTORY_CLI.md#worked-example-hackensack-next)"),
    "the README describes browser tests as evidence, links the FACTORY_CLI section and names hackensack-next as the worked example",
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
