import { realpathSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { projectContext } from "./factory/context.ts";
import { startRun, approveRun, revokeRun } from "./factory/runs.ts";
import { transitionRun } from "./factory/state.ts";
import { syncGuard, guardPath, type GuardMarker } from "./factory/guard.ts";
import { assert, cleanup, makeRepo, memDb, tempDir, sh, contractFor } from "./factory/testkit.ts";

const HOUR = 3_600_000;
const SETTINGS = "## Escapement Settings\n\n- **static**: npm run lint\n- **verify**: npm test\n";

function marker(path: string): GuardMarker | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as GuardMarker) : null;
}

function approved(db: Database, root: string, item: string) {
  const r = startRun(db, { workItem: item, ctx: projectContext(root), artifactDir: tempDir() });
  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
  return r.run_id;
}

async function run() {
  console.log("Guard marker\n");
  const db = await memDb();
  const root = realpathSync(makeRepo({ branch: "42-x", claudeMd: SETTINGS }));
  const path = guardPath(root);
  assert(path === join(root, ".git", "escapement-factory-run.json"), "the marker lives inside .git, outside the tree");

  const r = startRun(db, { workItem: "#42", ctx: projectContext(root), artifactDir: tempDir() });
  assert(!syncGuard(db, r.run_id).active && !existsSync(path), "a planned run has no marker");
  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
  assert(syncGuard(db, r.run_id).active, "approved under an active authorization: the guard is on");
  const m = marker(path)!;
  assert(m.run_id === "#42-r1" && m.worktree_path === root && m.commands.join("|") === "npm run lint|npm test" && m.deadline_at !== null, "it names the run, worktree, deadline and the static and verify commands");
  assert(sh("git", ["status", "--porcelain"], root) === "", "the tree stays clean");

  transitionRun(db, r.run_id, "implementing");
  assert(syncGuard(db, r.run_id).active, "still on while implementing");
  revokeRun(db, r.run_id);
  assert(!syncGuard(db, r.run_id).active && !existsSync(path), "revoked: the marker is removed");
  approveRun(db, r.run_id, { contractFile: contractFor(r.run_id), budgetMs: HOUR });
  assert(syncGuard(db, r.run_id).active && existsSync(path), "re-approved: back on");
  transitionRun(db, r.run_id, "validating");
  assert(syncGuard(db, r.run_id).active, "and while validating");
  transitionRun(db, r.run_id, "validated");
  assert(!syncGuard(db, r.run_id).active && !existsSync(path), "validated: implementation is over, the marker is removed");
  transitionRun(db, r.run_id, "closed", { action: "abandoned" });
  assert(!syncGuard(db, r.run_id).active, "closed: off");

  console.log("\nSettings\n");
  writeFileSync(join(root, "CLAUDE.md"), SETTINGS + "- **exec-hook**: off\n");
  sh("git", ["commit", "-qam", "exec-hook off"], root);
  const off = approved(db, root, "#43");
  assert(!syncGuard(db, off).active && !existsSync(path), "exec-hook: off writes no marker");
  transitionRun(db, off, "closed", { action: "abandoned" });
  writeFileSync(join(root, "CLAUDE.md"), "## Escapement Settings\n\n- **base-branch**: main\n");
  sh("git", ["commit", "-qam", "no checks"], root);
  const none = approved(db, root, "#44");
  assert(!syncGuard(db, none).active, "no static or verify command: nothing to guard");
  transitionRun(db, none, "closed", { action: "abandoned" });

  console.log("\nWorktrees\n");
  writeFileSync(join(root, "CLAUDE.md"), SETTINGS);
  sh("git", ["commit", "-qam", "checks again"], root);
  const linked = join(tempDir(), "linked");
  sh("git", ["worktree", "add", "-q", "-b", "45-y", linked], root);
  const wt = realpathSync(linked);
  const l = approved(db, wt, "#45");
  syncGuard(db, l);
  const lpath = guardPath(wt);
  assert(lpath !== path && lpath.includes(join(".git", "worktrees")) && marker(lpath)?.run_id === l, "a linked worktree gets its own marker");
  assert(!existsSync(path), "the main checkout's guard is unaffected");

  // A marker naming another, still open run of the worktree is left alone.
  writeFileSync(lpath, JSON.stringify({ version: 1, run_id: l, worktree_path: wt, deadline_at: null, commands: ["npm test"] }));
  const other = startRun(db, { workItem: "#46", ctx: { ...projectContext(wt), worktreePath: "/gone" }, artifactDir: tempDir() });
  assert(!syncGuard(db, other.run_id).active && syncGuard(db, l).active, "a run whose worktree is gone has no marker; the live one keeps its own");

  db.close();
  cleanup();
  console.log("\nAll guard tests passed.");
}

run().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
