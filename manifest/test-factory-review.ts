import { readFileSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { validateRun, type Report } from "./factory/validate.ts";
import { parseContract } from "./factory/schemas.ts";
import { requiredJudgments, exportSnapshot, snapshotDigest, reviewDir } from "./factory/review.ts";
import { assert, sh, cleanup } from "./factory/testkit.ts";
import { owner, SETTINGS, TEST_EV, TEST_FILE, project } from "./factory/fixtures.ts";

const validate = (db: Database, runId: string) => validateRun(db, runId, { owner, lockWaitMs: 5_000, graceMs: 200 });
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf-8"));

const CMD_EV = { id: "AC-2.e1", type: "command", kind: "regression", run: "true", expect: { exit_code: 0 } };
const MANUAL_EV = { id: "AC-3.e1", type: "manual", kind: "new_behavior", instructions: "Read docs/auth.md" };
const CRITERIA = [
  { id: "AC-1", text: "Expired tokens are rejected", evidence: [TEST_EV] },
  { id: "AC-2", text: "The CLI still runs", evidence: [CMD_EV] },
  { id: "AC-3", text: "Docs describe it", evidence: [MANUAL_EV] },
];

/** A validated attempt awaiting review: a sensitive file, a policy change and a modified assertion in the branch. */
async function awaiting() {
  const p = await project({
    branch: {
      "src/auth/refresh.ts": "export const refresh = 1;\n",
      "ci/static.sh": 'exit "$(cat ci/static-exit)"\n# tweak\n',
      "tests/auth.test.ts": TEST_FILE.replace("toBe(200)", "toBe(201)"),
    },
    contract: { criteria: CRITERIA },
  });
  const r = await validate(p.db, p.run.run_id);
  assert(r.status === "awaiting_review", `the attempt awaits review (${r.outcome ?? "no outcome"})`);
  const draft = readJson<Report>(r.report_path);
  const contract = parseContract(readFileSync(join(p.run.artifact_dir, "contract.json"), "utf-8"));
  return { ...p, r, draft, contract };
}

async function judgments() {
  console.log("Required judgments\n");
  const { root, draft, contract } = await awaiting();
  const req = requiredJudgments({ worktree: root, contract, draft });

  assert(req.evidence.map((e) => `${e.id}:${e.judgment}`).join() === "AC-1.e1:supports_criterion,AC-2.e1:supports_criterion,AC-3.e1:procedure_adequate", "every evidence ID; test and command take supports_criterion, manual takes procedure_adequate");
  const e1 = req.evidence[0];
  assert(e1.criterion === "Expired tokens are rejected" && e1.executed === "passed" && e1.spec === TEST_EV.selector, "with its criterion, the runner's result and its selector");
  assert(req.evidence[2].executed === "pending_manual" && req.evidence[2].spec === "Read docs/auth.md", "manual evidence is pending, with its instructions");

  const paths = req.sensitive_paths.map((s) => s.path);
  assert(paths.join() === "ci/static.sh,src/auth/refresh.ts", `the changed sensitive path and the policy change need sign-off → ${paths.join(", ")}`);
  assert(req.sensitive_paths[1].reasons[0] === "sensitive path (matches src/auth/**)", "with the pattern it matched");
  assert(req.sensitive_paths[0].reasons[0].startsWith("execution policy change"), "and the policy finding's detail");
  assert(req.modified_assertions.length === 1 && req.modified_assertions[0].location === "tests/auth.test.ts:2", "every modified-assertion location");
}

async function sensitiveAtBase() {
  console.log("\nSensitive patterns at both revisions\n");
  // The branch drops src/auth/** from sensitive-paths; the base's pattern still applies.
  const p = await project({
    branch: { "src/auth/refresh.ts": "x\n", "CLAUDE.md": SETTINGS.replace("- **sensitive-paths**: src/auth/**\n", "") },
  });
  const r = await validate(p.db, p.run.run_id);
  const draft = readJson<Report>(r.report_path);
  const contract = parseContract(readFileSync(join(p.run.artifact_dir, "contract.json"), "utf-8"));
  const paths = requiredJudgments({ worktree: p.root, contract, draft }).sensitive_paths.map((s) => s.path);
  assert(paths.includes("src/auth/refresh.ts"), "a branch can't drop the pattern that would catch its own change");
  assert(paths.includes("CLAUDE.md"), "and the settings change itself needs a sign-off");
}

async function snapshot() {
  console.log("\nSource snapshot\n");
  const { root, run, draft } = await awaiting();
  const dir = join(reviewDir(run.artifact_dir, 1), "source");
  const d1 = exportSnapshot(root, draft.head_sha, dir);
  assert(/^sha256:[0-9a-f]{64}$/.test(d1), "the snapshot has a sha256 digest");
  assert(readFileSync(join(dir, "src", "auth", "refresh.ts"), "utf-8") === "export const refresh = 1;\n", "it holds head_sha's files");
  assert(!existsSync(join(dir, ".git")), "and no repository");
  assert((statSync(join(dir, "src", "app.ts")).mode & 0o222) === 0, "its files are read-only");
  assert(snapshotDigest(dir) === d1, "the digest can be recomputed");

  // Live worktree changes don't reach the snapshot.
  writeFileSync(join(root, "src", "app.ts"), "export const app = 99;\n");
  assert(exportSnapshot(root, draft.head_sha, dir) === d1, "re-exporting the same revision gives the same digest, whatever the live tree holds");
  sh("git", ["checkout", "-q", "--", "src/app.ts"], root);

  chmodSync(join(dir, "src", "app.ts"), 0o644);
  writeFileSync(join(dir, "src", "app.ts"), "tampered\n");
  assert(snapshotDigest(dir) !== d1, "a changed file changes the digest");
  assert(exportSnapshot(root, draft.merge_base_sha, dir) !== d1, "another revision has another digest");
}

try {
  await judgments();
  await sensitiveAtBase();
  await snapshot();
  console.log("\nAll factory review tests passed.");
} finally {
  cleanup();
}
