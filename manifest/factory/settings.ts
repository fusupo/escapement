import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseEscapementSettings } from "../init.ts";
import { FactoryError, parseDuration } from "./util.ts";

/**
 * Factory settings from the "## Escapement Settings" section of a project's
 * CLAUDE.md (docs/FACTORY_DESIGN.md §8). Every key is optional.
 *
 * Settings are read when they are needed, not copied per run. Reports record
 * settingsDigest() in `policy_version`, and a branch that changes these
 * settings is an execution-policy change (§4.6), so weakening them is
 * visible rather than prevented here.
 */

export const CHECKS = ["setup", "static", "verify"] as const;
export type CheckName = (typeof CHECKS)[number];

export const TEST_RESULT_FORMATS = ["junit"] as const;
export const EXEC_HOOK_MODES = ["on", "off"] as const;
export const GATE_MODES = ["report-only"] as const;
/** Browser test tools a project can declare with `browser-tests` (#104). */
export const BROWSER_TEST_TOOLS = ["playwright"] as const;
export type BrowserTestTool = (typeof BROWSER_TEST_TOOLS)[number];

export type FactorySettings = {
  baseBranch: string | null;
  setup: string | null;
  static: string | null;
  verify: string | null;
  testResults: { format: (typeof TEST_RESULT_FORMATS)[number]; path: string } | null;
  requiredChecks: CheckName[];
  sensitivePaths: string[];
  validationFiles: string[];
  /** Globs naming test files, for change classification (§4.6). */
  testFiles: string[];
  maxAttempts: number;
  commandTimeoutMs: number;
  lockTimeoutMs: number;
  runBudgetMs: number;
  execHook: (typeof EXEC_HOOK_MODES)[number];
  gateMode: (typeof GATE_MODES)[number];
  /**
   * The gate's limits (§6.3, #110): a PR recommends auto_merge only when its
   * diff, its advisory findings and the run's attempts stay within them.
   */
  gateMaxDiffLines: number;
  gateMaxDiffFiles: number;
  gateMaxAdvisories: number;
  gateMaxAttempts: number;
  /**
   * The project's browser test tool, or null. Only reported by `check`, for
   * setup-work, its planner and the plan critic to plan UI criteria as test
   * evidence (#104); the runner does nothing else with it.
   */
  browserTests: BrowserTestTool | null;
};

/** The keys the factory reads, in the order §8 lists them (test-files added by #61). Others (context-path) are ignored. */
export const FACTORY_KEYS = [
  "base-branch",
  "setup",
  "static",
  "verify",
  "test-results",
  "required-checks",
  "sensitive-paths",
  "validation-files",
  "test-files",
  "max-attempts",
  "command-timeout",
  "lock-timeout",
  "run-budget",
  "exec-hook",
  "gate-mode",
  "gate-max-diff-lines",
  "gate-max-diff-files",
  "gate-max-advisories",
  "gate-max-attempts",
  "browser-tests",
] as const;

export const SETTING_DEFAULTS = {
  "required-checks": "static, verify",
  "test-files": "*.test.*, *.spec.*, test/, tests/, __tests__/, test_*.py, *_test.py, *_test.go",
  "max-attempts": "3",
  "command-timeout": "15m",
  "lock-timeout": "30m",
  "run-budget": "2h",
  "exec-hook": "on",
  "gate-mode": "report-only",
  "gate-max-diff-lines": "400",
  "gate-max-diff-files": "15",
  "gate-max-advisories": "0",
  "gate-max-attempts": "1",
} as const;

export type SettingsError = { key: string; message: string };

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function oneOf<T extends string>(key: string, value: string, allowed: readonly T[], errors: SettingsError[], fallback: T): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  errors.push({ key, message: `"${value}" is not one of ${allowed.join(", ")}` });
  return fallback;
}

/**
 * Turn raw settings into typed ones. An absent or empty key takes its
 * default. Every invalid value is reported, so a caller can list them all.
 */
export function parseFactorySettings(raw: Map<string, string>): { settings: FactorySettings; errors: SettingsError[] } {
  const errors: SettingsError[] = [];
  const get = (key: string): string | null => {
    const v = raw.get(key)?.trim();
    return v ? v : null;
  };
  const withDefault = (key: keyof typeof SETTING_DEFAULTS): string => get(key) ?? SETTING_DEFAULTS[key];

  const duration = (key: "command-timeout" | "lock-timeout" | "run-budget"): number => {
    const value = withDefault(key);
    try {
      return parseDuration(value);
    } catch {
      errors.push({ key, message: `"${value}" is not a duration (use e.g. 30s, 15m, 2h)` });
      return parseDuration(SETTING_DEFAULTS[key]);
    }
  };

  let testResults: FactorySettings["testResults"] = null;
  const tr = get("test-results");
  if (tr !== null) {
    const m = tr.match(/^([a-z]+):(.+)$/);
    if (!m) {
      errors.push({ key: "test-results", message: `"${tr}" should be format:path, e.g. junit:$FACTORY_RESULTS_DIR/junit.xml` });
    } else if (!(TEST_RESULT_FORMATS as readonly string[]).includes(m[1])) {
      errors.push({ key: "test-results", message: `format "${m[1]}" is not supported (use ${TEST_RESULT_FORMATS.join(", ")})` });
    } else {
      testResults = { format: m[1] as "junit", path: m[2].trim() };
    }
  }

  const requiredChecks: CheckName[] = [];
  for (const name of list(withDefault("required-checks"))) {
    if (!(CHECKS as readonly string[]).includes(name)) {
      errors.push({ key: "required-checks", message: `unknown check "${name}" (use ${CHECKS.join(", ")})` });
    } else if (!requiredChecks.includes(name as CheckName)) {
      requiredChecks.push(name as CheckName);
    }
  }

  const attempts = withDefault("max-attempts");
  let maxAttempts = Number(SETTING_DEFAULTS["max-attempts"]);
  if (/^[1-9]\d*$/.test(attempts)) {
    maxAttempts = Number(attempts);
  } else {
    errors.push({ key: "max-attempts", message: `"${attempts}" is not a positive whole number` });
  }

  // The gate's limits (#110): lines, files and advisories may be 0; a run
  // always makes at least one attempt, so its limit is at least 1.
  const count = (key: "gate-max-diff-lines" | "gate-max-diff-files" | "gate-max-advisories" | "gate-max-attempts"): number => {
    const value = withDefault(key);
    const positive = key === "gate-max-attempts";
    if ((positive ? /^[1-9]\d*$/ : /^\d+$/).test(value)) return Number(value);
    errors.push({ key, message: `"${value}" is not a ${positive ? "positive" : "non-negative"} whole number` });
    return Number(SETTING_DEFAULTS[key]);
  };

  const bt = get("browser-tests");
  let browserTests: BrowserTestTool | null = null;
  if (bt !== null) {
    if ((BROWSER_TEST_TOOLS as readonly string[]).includes(bt)) browserTests = bt as BrowserTestTool;
    else errors.push({ key: "browser-tests", message: `"${bt}" is not a supported browser test tool (use ${BROWSER_TEST_TOOLS.join(", ")})` });
  }

  const settings: FactorySettings = {
    baseBranch: get("base-branch"),
    setup: get("setup"),
    static: get("static"),
    verify: get("verify"),
    testResults,
    requiredChecks,
    sensitivePaths: list(get("sensitive-paths") ?? ""),
    validationFiles: list(get("validation-files") ?? ""),
    testFiles: list(withDefault("test-files")),
    maxAttempts,
    commandTimeoutMs: duration("command-timeout"),
    lockTimeoutMs: duration("lock-timeout"),
    runBudgetMs: duration("run-budget"),
    execHook: oneOf("exec-hook", withDefault("exec-hook"), EXEC_HOOK_MODES, errors, "on"),
    gateMode: oneOf("gate-mode", withDefault("gate-mode"), GATE_MODES, errors, "report-only"),
    gateMaxDiffLines: count("gate-max-diff-lines"),
    gateMaxDiffFiles: count("gate-max-diff-files"),
    gateMaxAdvisories: count("gate-max-advisories"),
    gateMaxAttempts: count("gate-max-attempts"),
    browserTests,
  };
  return { settings, errors };
}

/**
 * Digest of the factory settings as written, for a report's
 * `policy_version`. Only factory keys count, so changing context-path or
 * reordering lines doesn't change it.
 */
export function settingsDigest(raw: Map<string, string>): string {
  const canonical = FACTORY_KEYS.map((k) => [k, raw.get(k)?.trim() || null]);
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type LoadedSettings = {
  settings: FactorySettings;
  errors: SettingsError[];
  digest: string;
  /** The CLAUDE.md read, or null when the project has none. */
  source: string | null;
};

/** Read and parse the factory settings from `{dir}/CLAUDE.md`, collecting errors. */
export function readSettings(dir: string): LoadedSettings {
  const file = join(dir, "CLAUDE.md");
  const raw = existsSync(file) ? parseEscapementSettings(readFileSync(file, "utf-8")) : new Map<string, string>();
  const { settings, errors } = parseFactorySettings(raw);
  return { settings, errors, digest: settingsDigest(raw), source: existsSync(file) ? file : null };
}

/** Like readSettings, but invalid settings are an error (`bad_setting`). */
export function loadSettings(dir: string): LoadedSettings {
  const loaded = readSettings(dir);
  if (loaded.errors.length > 0) {
    const where = loaded.source ?? join(dir, "CLAUDE.md");
    const lines = loaded.errors.map((e) => `  ${e.key}: ${e.message}`).join("\n");
    throw new FactoryError("bad_setting", `invalid Escapement Settings in ${where}:\n${lines}`);
  }
  return loaded;
}
