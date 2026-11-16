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

export type FactorySettings = {
  baseBranch: string | null;
  setup: string | null;
  static: string | null;
  verify: string | null;
  testResults: { format: (typeof TEST_RESULT_FORMATS)[number]; path: string } | null;
  requiredChecks: CheckName[];
  sensitivePaths: string[];
  validationFiles: string[];
  maxAttempts: number;
  commandTimeoutMs: number;
  lockTimeoutMs: number;
  runBudgetMs: number;
  execHook: (typeof EXEC_HOOK_MODES)[number];
  gateMode: (typeof GATE_MODES)[number];
};

/** The keys the factory reads, in the order §8 lists them. Others (context-path) are ignored. */
export const FACTORY_KEYS = [
  "base-branch",
  "setup",
  "static",
  "verify",
  "test-results",
  "required-checks",
  "sensitive-paths",
  "validation-files",
  "max-attempts",
  "command-timeout",
  "lock-timeout",
  "run-budget",
  "exec-hook",
  "gate-mode",
] as const;

export const SETTING_DEFAULTS = {
  "required-checks": "static, verify",
  "max-attempts": "3",
  "command-timeout": "15m",
  "lock-timeout": "30m",
  "run-budget": "2h",
  "exec-hook": "off",
  "gate-mode": "report-only",
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

  const settings: FactorySettings = {
    baseBranch: get("base-branch"),
    setup: get("setup"),
    static: get("static"),
    verify: get("verify"),
    testResults,
    requiredChecks,
    sensitivePaths: list(get("sensitive-paths") ?? ""),
    validationFiles: list(get("validation-files") ?? ""),
    maxAttempts,
    commandTimeoutMs: duration("command-timeout"),
    lockTimeoutMs: duration("lock-timeout"),
    runBudgetMs: duration("run-budget"),
    execHook: oneOf("exec-hook", withDefault("exec-hook"), EXEC_HOOK_MODES, errors, "off"),
    gateMode: oneOf("gate-mode", withDefault("gate-mode"), GATE_MODES, errors, "report-only"),
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
