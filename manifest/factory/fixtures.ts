// A project for validation tests: a git repo with fake checks, a feature
// branch, and a run started and approved for it. Used by the validate and
// review suites.
import { writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Database } from "better-sqlite3";
import { startRun, approveRun } from "./runs.ts";
import { projectContext } from "./context.ts";
import { getRun } from "./state.ts";
import { currentOwner } from "./owner.ts";
import { tempDir, makeRepo, sh, memDb } from "./testkit.ts";

// Checks that commit need an identity; the runner passes its environment on.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
});

export const owner = currentOwner("test factory");
export const HOUR = 3_600_000;

export const SETTINGS = `## Escapement Settings

- **static**: sh ci/static.sh
- **verify**: sh ci/verify.sh
- **test-results**: junit:$FACTORY_RESULTS_DIR/junit.xml
- **sensitive-paths**: src/auth/**
- **validation-files**: ci/**
`;

/** Fake checks: static exits with ci/static-exit; verify copies ci/junit.xml to the results dir and exits with ci/verify-exit. */
export const STATIC_SH = 'exit "$(cat ci/static-exit)"\n';
export const VERIFY_SH = 'cp ci/junit.xml "$FACTORY_RESULTS_DIR/junit.xml"\nexit "$(cat ci/verify-exit)"\n';

export function junit(cases: { name: string; status?: "failed" | "skipped" }[], file = "tests/auth.test.ts"): string {
  const body = cases
    .map((c) =>
      c.status === "failed"
        ? `<testcase name="${c.name}" classname="auth" file="${file}"><failure message="expected 401, got 500">trace</failure></testcase>`
        : c.status === "skipped"
          ? `<testcase name="${c.name}" classname="auth" file="${file}"><skipped/></testcase>`
          : `<testcase name="${c.name}" classname="auth" file="${file}"/>`,
    )
    .join("\n");
  return `<testsuites><testsuite name="auth">\n${body}\n</testsuite></testsuites>\n`;
}

export const PASSING = junit([{ name: "auth rejects expired" }, { name: "auth refreshes" }]);
export const TEST_FILE = "it('refreshes', () => {\n  expect(refresh()).toBe(200);\n});\n\nit('keeps', () => {\n  expect(keep()).toBe(true);\n});\n";

export function write(root: string, files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

export function commit(root: string, files: Record<string, string | null>, msg = "change"): string {
  write(root, files);
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", msg], root);
  return sh("git", ["rev-parse", "HEAD"], root);
}

export type Evidence = Record<string, unknown>;
export const TEST_EV: Evidence = { id: "AC-1.e1", type: "test", kind: "new_behavior", selector: "tests/auth.test.ts::rejects expired" };

/**
 * A repo with checks on main and a feature branch whose commit applies
 * `branch`, a run for it started and approved with `evidence`.
 */
export async function project(opts: {
  db?: Database;
  settings?: string;
  base?: Record<string, string | null>;
  branch?: Record<string, string | null>;
  evidence?: Evidence[];
  contract?: Record<string, unknown>;
}) {
  const db = opts.db ?? (await memDb());
  const root = realpathSync(makeRepo({ branch: "main", claudeMd: opts.settings ?? SETTINGS }));
  commit(
    root,
    {
      "ci/static.sh": STATIC_SH,
      "ci/verify.sh": VERIFY_SH,
      "ci/static-exit": "0\n",
      "ci/verify-exit": "0\n",
      "ci/junit.xml": PASSING,
      "tests/auth.test.ts": TEST_FILE,
      "src/app.ts": "export const app = 1;\n",
      ...opts.base,
    },
    "base",
  );
  sh("git", ["checkout", "-q", "-b", "feature"], root);
  commit(root, { "src/app.ts": "export const app = 2;\n", ...opts.branch }, "work");
  const run = startRun(db, { workItem: "#7", ctx: projectContext(root), artifactDir: tempDir("factory-art-"), targetRef: "main" });
  const contractFile = join(tempDir(), "contract.json");
  writeFileSync(
    contractFile,
    JSON.stringify({
      version: 1,
      run_id: run.run_id,
      risk_tier_proposed: "standard",
      criteria: [{ id: "AC-1", text: "Expired tokens are rejected", evidence: opts.evidence ?? [TEST_EV] }],
      ...opts.contract,
    }),
  );
  approveRun(db, run.run_id, { contractFile, budgetMs: 2 * HOUR });
  return { db, root, run: getRun(db, run.run_id) };
}

