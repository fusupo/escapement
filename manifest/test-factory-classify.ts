import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { classifyHunk, classifyChanges, parseHunks, settingsChange } from "./factory/classify.ts";
import { changedFiles } from "./factory/revision.ts";
import { parseEscapementSettings } from "./init.ts";
import { SETTING_DEFAULTS } from "./factory/settings.ts";
import { assert, makeRepo, sh, cleanup } from "./factory/testkit.ts";

const DEFAULT_TESTS = SETTING_DEFAULTS["test-files"].split(",").map((s) => s.trim());
const hunk = (added: string[], removed: string[] = []) => ({ oldStart: 1, newStart: 1, added, removed });

function hunks() {
  console.log("Hunks\n");

  const diff = "diff --git a/t.test.ts b/t.test.ts\n--- a/t.test.ts\n+++ b/t.test.ts\n@@ -3 +3 @@\n-  expect(x).toBe(401);\n+  expect(x).toBe(500);\n@@ -9,0 +10,3 @@\n+it('new', () => {\n+  expect(1).toBe(1);\n+});\n";
  const h = parseHunks(diff);
  assert(h.length === 2 && h[0].removed.length === 1 && h[1].newStart === 10 && h[1].added.length === 3, "git diff -U0 hunks are parsed");

  const c = (added: string[], removed: string[] = []) => classifyHunk(hunk(added, removed)).class;
  assert(c(["  expect(x).toBe(500);"], ["  expect(x).toBe(401);"]) === "modified_assertion", "a changed assertion is modified");
  assert(c([], ["  expect(x).toBe(401);"]) === "modified_assertion", "a removed assertion is modified");
  assert(c(["", "it('rejects expired token', async () => {", "  expect(await f()).toBe(401);", "});"]) === "new_evidence", "a new it() block is new evidence");
  assert(c(["});", "", "test.each([1, 2])('n=%i', (n) => {", "  expect(n).toBeGreaterThan(0);"]) === "new_evidence", "a new block after the previous block's closer is new evidence");
  assert(c(["def test_rejects_expired():", "    assert f() == 401"]) === "new_evidence", "a new pytest function is new evidence");
  assert(c(["@pytest.mark.parametrize('n', [1, 2])", "def test_n(n):", "    assert n"]) === "new_evidence", "a decorated pytest function is new evidence");
  assert(c(["func TestRefresh(t *testing.T) {", "\tif f() != 401 { t.Fatal() }", "}"]) === "new_evidence", "a new Go test is new evidence");
  assert(c(["#[test]", "fn refresh() { assert_eq!(f(), 401); }"]) === "new_evidence", "a new Rust test is new evidence");
  assert(c(["  expect(y).toBe(2);"]) === "modified_assertion", "a line added inside an existing test is ambiguous → modified");
  assert(c(["  it('nested', () => {});", "expect(z).toBe(1);"]) === "modified_assertion", "a test start followed by a less-indented line is ambiguous → modified");
  assert(c(["it.skip('flaky', () => {", "});"]) === "modified_assertion", "an added it.skip is modified");
  assert(c(["it.only('this one', () => {", "});"]) === "modified_assertion", "an added .only narrows the run → modified");
  assert(c(["@pytest.mark.skip(reason='later')", "def test_x():", "    pass"]) === "modified_assertion", "an added pytest skip is modified");
  assert(c(["\tt.Skip(\"later\")"]) === "modified_assertion", "an added t.Skip is modified");
  assert(c(["", "  "]) === "modified_assertion", "blank-only additions are ambiguous → modified");
}

function commit(root: string, files: Record<string, string | null>, msg: string): string {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) rmSync(full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", msg], root);
  return sh("git", ["rev-parse", "HEAD"], root);
}

const SETTINGS = "## Escapement Settings\n\n- **verify**: npm test\n- **required-checks**: static, verify\n- **validation-files**: jest.config.*, package.json\n";

function repo() {
  console.log("\nA branch diff\n");

  const root = makeRepo({ claudeMd: SETTINGS });
  const existing = "describe('refresh', () => {\n  it('refreshes', () => {\n    expect(refresh()).toBe(200);\n  });\n});\n";
  const base = commit(
    root,
    {
      "src/auth.ts": "export const f = 1;\n",
      "tests/refresh.test.ts": existing,
      "tests/old.test.ts": "it('old', () => {});\n",
      "src/__tests__/util.ts": "export const helper = 1;\n",
      "spec/x.rb": "it 'x'\n",
    },
    "base",
  );
  const classify = (head: string, selectorFiles: string[] = []) =>
    classifyChanges({
      worktree: root,
      base,
      head,
      files: changedFiles(root, base, head),
      headSettings: { testFiles: DEFAULT_TESTS, validationFiles: ["jest.config.*", "package.json"] },
      selectorFiles,
    });

  {
    const head = commit(
      root,
      {
        "src/auth.ts": "export const f = 2;\n",
        "tests/new.test.ts": "it('new', () => {});\n",
        "tests/refresh.test.ts": existing.replace("  });\n});", "  });\n\n  it('rejects expired', () => {\n    expect(refresh(old)).toBe(401);\n  });\n});"),
      },
      "new tests",
    );
    const r = classify(head);
    assert(r.new_evidence === 2 && r.modified_assertions === 0 && r.execution_policy === 0, "a new test file and a new test block are new evidence");
    assert(r.test_files.join() === "tests/new.test.ts,tests/refresh.test.ts", "source files are not test files");
    sh("git", ["reset", "-q", "--hard", base], root);
  }

  {
    const head = commit(
      root,
      {
        "tests/refresh.test.ts": existing.replace("toBe(200)", "toBe(500)"),
        "tests/old.test.ts": null,
        "src/__tests__/util.ts": "export const helper = 2;\n",
      },
      "modified tests",
    );
    const r = classify(head);
    const locs = r.items.filter((i) => i.class === "modified_assertion").map((i) => `${i.location} (${i.detail})`);
    assert(r.modified_assertions === 3, `an edited assertion, a deleted test file and an edited __tests__ helper are modified → ${locs.join("; ")}`);
    assert(locs.includes("tests/refresh.test.ts:3 (existing test lines changed)"), "the location is file:line in the head revision");
    assert(locs.includes("tests/old.test.ts (test file deleted)"), "a deleted test file is located by its path");
    sh("git", ["reset", "-q", "--hard", base], root);
  }

  {
    const head = commit(root, { "spec/x.rb": "it 'y'\n" }, "spec");
    assert(classify(head).test_files.length === 0, "a file matching no test-files pattern isn't classified");
    assert(classify(head, ["spec/x.rb"]).modified_assertions === 1, "a file named by a contract selector is a test file");
    sh("git", ["reset", "-q", "--hard", base], root);
  }

  {
    const head = commit(root, { "jest.config.js": "module.exports = {};\n", "package.json": "{}\n" }, "config");
    const r = classify(head);
    assert(r.execution_policy === 2 && r.policy_reasons.length === 2, "validation-files changes are execution policy");
    assert(r.policy_reasons[0] === "execution policy: jest.config.js (matches jest.config.*)", "with the matching pattern");
    sh("git", ["reset", "-q", "--hard", base], root);
  }

  {
    const head = commit(root, { "CLAUDE.md": SETTINGS.replace("static, verify", "static").replace("- **validation-files**: jest.config.*, package.json\n", "") + "", "jest.config.js": "x\n" }, "weaken");
    const r = classify(head);
    const reason = r.policy_reasons.find((p) => p.includes("CLAUDE.md")) ?? "";
    assert(reason.includes("required-checks, validation-files") && reason.includes("required-checks weakened: dropped verify"), `weakened settings are execution policy → ${reason}`);
    assert(r.policy_reasons.some((p) => p.startsWith("execution policy: jest.config.js")), "a branch that drops a validation-files pattern is still caught by the base's pattern");
    sh("git", ["reset", "-q", "--hard", base], root);
  }

  {
    const head = commit(root, { "CLAUDE.md": SETTINGS + "- **context-path**: ../ctx\n\nMore docs.\n" }, "docs");
    assert(classify(head).execution_policy === 0, "a CLAUDE.md edit that leaves the factory settings alone is not a policy change");
  }

  const raw = (s: string) => parseEscapementSettings(s);
  assert(settingsChange(raw(SETTINGS), raw(SETTINGS)) === null, "identical settings: no change");
}

try {
  hunks();
  repo();
  console.log("\nAll factory classification tests passed.");
} finally {
  cleanup();
}
