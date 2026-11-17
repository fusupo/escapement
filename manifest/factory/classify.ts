import { execFileSync } from "node:child_process";
import { parseEscapementSettings } from "../init.ts";
import { firstMatch } from "./glob.ts";
import { fileAt, type ChangedFile } from "./revision.ts";
import { parseFactorySettings, settingsDigest, FACTORY_KEYS, type FactorySettings } from "./settings.ts";

/**
 * Test and policy change classification (docs/FACTORY_DESIGN.md §4.6),
 * over the full branch diff `merge_base..head`. The baseline is git's own
 * tree at the merge base, read when validating, so a rebase onto a newer
 * target is classified against the new merge base.
 *
 * | class              | what                                                       |
 * |--------------------|------------------------------------------------------------|
 * | new_evidence       | a new test file, or a hunk that only adds a new test block |
 * | modified_assertion | a changed, removed, skipped or ambiguous test edit         |
 * | execution_policy   | a changed validation-files file, or changed factory settings |
 *
 * The rules are textual and deliberately conservative: anything that isn't
 * clearly a new test is a modified assertion. They make tampering visible,
 * not impossible.
 */

export type ChangeClass = "new_evidence" | "modified_assertion" | "execution_policy";

export type ChangeItem = {
  class: ChangeClass;
  /** `path` or `path:line` (line in the head revision). */
  location: string;
  detail: string;
};

export type Classification = {
  new_evidence: number;
  modified_assertions: number;
  execution_policy: number;
  items: ChangeItem[];
  /** Changed files treated as test files. */
  test_files: string[];
  /** Why the run is sensitive because of policy changes (for the tier). */
  policy_reasons: string[];
};

/** The settings file, at the worktree root. */
export const SETTINGS_FILE = "CLAUDE.md";

/** A line that starts a test block, in the common test frameworks. */
const TEST_START = new RegExp(
  [
    String.raw`(?:it|test|describe|context|suite|specify)(?:\.each\b.*?)?\s*\(`, // JS/TS: jest, vitest, mocha, node:test
    String.raw`(?:async\s+)?def\s+test\w*\s*\(`, // pytest, unittest
    String.raw`class\s+Test\w*`, // pytest/unittest classes
    String.raw`func\s+(?:Test|Benchmark|Example|Fuzz)\w*\s*\(`, // Go
    String.raw`#\[(?:\w+::)*test\]`, // Rust
    String.raw`@(?:Test|ParameterizedTest)\b`, // JUnit
    String.raw`@pytest\.`, // a decorator before a new pytest test
  ]
    .map((alt) => `(?:${alt})`)
    .join("|"),
);

/** Markers that skip, narrow or stub tests. An added one is a modified assertion. */
const SKIP_MARKER = new RegExp(
  [
    String.raw`\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\b`,
    String.raw`\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(`,
    String.raw`@pytest\.mark\.(?:skip|skipif|xfail)\b`,
    String.raw`\bpytest\.skip\s*\(`,
    String.raw`@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b`,
    String.raw`\bt\.Skip(?:f|Now)?\s*\(`,
    String.raw`#\[ignore\b`,
    String.raw`@(?:Disabled|Ignore)\b`,
  ].join("|"),
);

/** Leading lines a new test block can follow: blanks and closers of the previous block. */
const FILLER = /^\s*(?:[})\];,]+\s*)*$/;

export type Hunk = { oldStart: number; newStart: number; removed: string[]; added: string[] };

/** Parse `git diff -U0` output into hunks. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      cur = { oldStart: Number(m[1]), newStart: Number(m[2]), removed: [], added: [] };
      hunks.push(cur);
    } else if (cur && line.startsWith("-") && !line.startsWith("---")) {
      cur.removed.push(line.slice(1));
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.added.push(line.slice(1));
    }
  }
  return hunks;
}

/** One hunk of an existing test file → its class and why. */
export function classifyHunk(h: Hunk): { class: "new_evidence" | "modified_assertion"; detail: string } {
  if (h.removed.length > 0) {
    return { class: "modified_assertion", detail: h.added.length ? "existing test lines changed" : "existing test lines removed" };
  }
  if (h.added.some((l) => SKIP_MARKER.test(l))) {
    return { class: "modified_assertion", detail: "adds a skip, only or todo marker" };
  }
  const first = h.added.find((l) => !FILLER.test(l));
  if (first !== undefined && TEST_START.test(first.trimStart()) && /^\s*/.exec(first)![0].length <= leastIndent(h.added)) {
    return { class: "new_evidence", detail: "new test block" };
  }
  return { class: "modified_assertion", detail: "lines added inside an existing test (ambiguous)" };
}

/** The smallest indentation among non-filler lines, so a new block isn't nested in an existing one's tail. */
function leastIndent(lines: string[]): number {
  let least = Infinity;
  for (const l of lines) {
    if (FILLER.test(l)) continue;
    least = Math.min(least, /^\s*/.exec(l)![0].length);
  }
  return least;
}

function fileDiff(worktree: string, base: string, head: string, path: string): string {
  return execFileSync("git", ["diff", "-U0", "--no-color", "--no-renames", base, head, "--", path], {
    cwd: worktree,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The raw factory settings in CLAUDE.md at `rev` (empty when it has none). */
export function settingsAt(worktree: string, rev: string): Map<string, string> {
  const text = fileAt(worktree, rev, SETTINGS_FILE);
  return text === null ? new Map() : parseEscapementSettings(text);
}

/** How the factory settings differ between two revisions: the changed keys and any dropped required check. */
export function settingsChange(
  baseRaw: Map<string, string>,
  headRaw: Map<string, string>,
): { changed: string[]; droppedChecks: string[] } | null {
  if (settingsDigest(baseRaw) === settingsDigest(headRaw)) return null;
  const val = (m: Map<string, string>, k: string) => m.get(k)?.trim() || null;
  const changed = FACTORY_KEYS.filter((k) => val(baseRaw, k) !== val(headRaw, k));
  const before = parseFactorySettings(baseRaw).settings.requiredChecks;
  const after = parseFactorySettings(headRaw).settings.requiredChecks;
  return { changed, droppedChecks: before.filter((c) => !after.includes(c)) };
}

/**
 * Classify every change in `files` (the diff `base..head`). Test files are
 * those matching `test-files` at either revision, plus `selectorFiles` (the
 * files named by the contract's test selectors); `validation-files` is also
 * taken from both revisions, so a branch can't hide a change by editing the
 * pattern that would catch it.
 */
export function classifyChanges(opts: {
  worktree: string;
  base: string;
  head: string;
  files: readonly ChangedFile[];
  headSettings: Pick<FactorySettings, "testFiles" | "validationFiles">;
  selectorFiles?: readonly string[];
}): Classification {
  const baseRaw = settingsAt(opts.worktree, opts.base);
  const headRaw = settingsAt(opts.worktree, opts.head);
  const baseSettings = parseFactorySettings(baseRaw).settings;
  const testPatterns = [...new Set([...opts.headSettings.testFiles, ...baseSettings.testFiles])];
  const policyPatterns = [...new Set([...opts.headSettings.validationFiles, ...baseSettings.validationFiles])];
  const selectorFiles = new Set((opts.selectorFiles ?? []).map((f) => f.replace(/^\.\//, "")));

  const items: ChangeItem[] = [];
  const testFiles: string[] = [];
  const policyReasons: string[] = [];

  for (const f of opts.files) {
    const policy = firstMatch(f.path, policyPatterns);
    if (policy) {
      items.push({ class: "execution_policy", location: f.path, detail: `validation file changed (matches ${policy})` });
      policyReasons.push(`execution policy: ${f.path} (matches ${policy})`);
    }
    const isTest = selectorFiles.has(f.path) || firstMatch(f.path, testPatterns) !== null;
    if (!isTest) continue;
    testFiles.push(f.path);
    if (f.status === "A") {
      items.push({ class: "new_evidence", location: f.path, detail: "new test file" });
    } else if (f.status === "D") {
      items.push({ class: "modified_assertion", location: f.path, detail: "test file deleted" });
    } else {
      const hunks = parseHunks(fileDiff(opts.worktree, opts.base, opts.head, f.path));
      if (hunks.length === 0) {
        items.push({ class: "modified_assertion", location: f.path, detail: "test file changed (no text diff)" });
      }
      for (const h of hunks) {
        const c = classifyHunk(h);
        items.push({ class: c.class, location: `${f.path}:${h.newStart}`, detail: c.detail });
      }
    }
  }

  const change = settingsChange(baseRaw, headRaw);
  if (change) {
    const weakened = change.droppedChecks.length ? `; required-checks weakened: dropped ${change.droppedChecks.join(", ")}` : "";
    items.push({ class: "execution_policy", location: SETTINGS_FILE, detail: `factory settings changed: ${change.changed.join(", ")}${weakened}` });
    policyReasons.push(`execution policy: factory settings changed in ${SETTINGS_FILE} (${change.changed.join(", ")})${weakened}`);
  }

  const count = (c: ChangeClass) => items.filter((i) => i.class === c).length;
  return {
    new_evidence: count("new_evidence"),
    modified_assertions: count("modified_assertion"),
    execution_policy: count("execution_policy"),
    items,
    test_files: testFiles,
    policy_reasons: policyReasons,
  };
}
