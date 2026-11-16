import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEscapementSettings } from "./init.ts";
import { parseFactorySettings, readSettings, loadSettings, settingsDigest } from "./factory/settings.ts";
import { assert, throws, tempDir, cleanup } from "./factory/testkit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parse = (md: string) => parseFactorySettings(parseEscapementSettings(md));

const FULL = `## Escapement Settings

- **context-path**: ../myproject-ctx
- **base-branch**: develop
- **setup**: npm ci
- **static**: npm run typecheck && npm run lint
- **verify**: npx jest --runInBand --reporters=default --reporters=jest-junit
- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml
- **required-checks**: static, verify, setup
- **sensitive-paths**: src/auth/**, migrations/**, src/billing/**, .github/**
- **validation-files**: jest.config.*, tsconfig*.json, .eslintrc*, package.json
- **max-attempts**: 5
- **command-timeout**: 10m
- **lock-timeout**: 45s
- **run-budget**: 3h
- **exec-hook**: on
- **gate-mode**: report-only
`;

function run() {
  console.log("Factory settings\n");

  {
    const { settings: s, errors } = parse(FULL);
    assert(errors.length === 0, "the full §8 example parses without errors");
    assert(s.baseBranch === "develop" && s.setup === "npm ci", "base-branch and setup");
    assert(s.static === "npm run typecheck && npm run lint", "static keeps the whole command");
    assert(s.verify!.startsWith("npx jest --runInBand"), "verify");
    assert(s.testResults?.format === "junit" && s.testResults.path === "$FACTORY_RESULTS_DIR/junit.xml", "test-results is format and path");
    assert(s.requiredChecks.join() === "static,verify,setup", "required-checks is a list of checks");
    assert(s.sensitivePaths.length === 4 && s.sensitivePaths[0] === "src/auth/**", "sensitive-paths is a list of globs");
    assert(s.validationFiles.join() === "jest.config.*,tsconfig*.json,.eslintrc*,package.json", "validation-files is a list of globs");
    assert(s.maxAttempts === 5, "max-attempts");
    assert(s.commandTimeoutMs === 600_000 && s.lockTimeoutMs === 45_000 && s.runBudgetMs === 3 * 3_600_000, "timeouts and run-budget are durations");
    assert(s.execHook === "on" && s.gateMode === "report-only", "exec-hook and gate-mode");
  }

  {
    const { settings: s, errors } = parse("# No settings at all\n");
    assert(errors.length === 0, "a CLAUDE.md without the section is valid");
    assert(s.baseBranch === null && s.setup === null && s.static === null && s.verify === null, "absent commands are null");
    assert(s.testResults === null && s.sensitivePaths.length === 0 && s.validationFiles.length === 0, "absent lists are empty");
    assert(s.requiredChecks.join() === "static,verify", "required-checks defaults to static, verify");
    assert(s.maxAttempts === 3, "max-attempts defaults to 3");
    assert(s.commandTimeoutMs === 900_000 && s.lockTimeoutMs === 1_800_000 && s.runBudgetMs === 7_200_000, "durations default to 15m, 30m, 2h");
    assert(s.execHook === "off" && s.gateMode === "report-only", "exec-hook off, gate-mode report-only");
    const empty = parse("## Escapement Settings\n- **verify**:\n- **max-attempts**:\n");
    assert(empty.errors.length === 0 && empty.settings.verify === null && empty.settings.maxAttempts === 3, "an empty value means absent");
  }

  {
    const bad = parse(`## Escapement Settings
- **test-results**: tap:out.tap
- **required-checks**: static, lint
- **max-attempts**: 0
- **command-timeout**: 10
- **exec-hook**: maybe
- **gate-mode**: enforce
`);
    const keys = bad.errors.map((e) => e.key).join();
    assert(keys === "test-results,required-checks,max-attempts,command-timeout,exec-hook,gate-mode", "every invalid value is reported, by key");
    assert(bad.errors[1].message.includes('unknown check "lint"'), "messages say what is wrong");
    assert(parse("## Escapement Settings\n- **test-results**: results.xml\n").errors[0].message.includes("format:path"), "test-results needs a format");
    const dup = parse("## Escapement Settings\n- **required-checks**: verify, verify\n");
    assert(dup.settings.requiredChecks.join() === "verify", "repeated required checks count once");
  }

  console.log("\nReal documents\n");

  {
    const root = resolve(__dirname, "..");
    const own = readSettings(root);
    assert(own.errors.length === 0 && own.source === join(root, "CLAUDE.md"), "Escapement's CLAUDE.md is read without errors");
    const s = own.settings;
    assert(s.verify === null && s.static === null && s.sensitivePaths.length === 0, "its doc examples are not picked up");
    const design = parse(readFileSync(join(root, "docs", "FACTORY_DESIGN.md"), "utf-8"));
    assert(design.settings.verify === null && design.settings.maxAttempts === 3, "the fenced §8 example in FACTORY_DESIGN.md is ignored");
  }

  console.log("\nDigest and loading\n");

  {
    const a = parseEscapementSettings(FULL);
    const b = parseEscapementSettings(FULL.replace("../myproject-ctx", "../other-ctx"));
    const c = parseEscapementSettings(FULL.replace("max-attempts**: 5", "max-attempts**: 4"));
    assert(settingsDigest(a) === settingsDigest(b), "context-path doesn't change the digest");
    assert(settingsDigest(a) !== settingsDigest(c), "a factory setting does");
    assert(/^sha256:[0-9a-f]{64}$/.test(settingsDigest(a)), "the digest is sha256:hex");

    const dir = tempDir();
    assert(readSettings(dir).source === null && readSettings(dir).errors.length === 0, "a project without CLAUDE.md gets defaults");
    writeFileSync(join(dir, "CLAUDE.md"), "## Escapement Settings\n- **max-attempts**: many\n");
    throws(() => loadSettings(dir), /bad_setting/, "loadSettings rejects invalid settings");
    try {
      loadSettings(dir);
    } catch (e) {
      assert((e as Error).message.includes("max-attempts:"), "the error names the key");
    }
  }

  console.log("\nAll factory settings tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
