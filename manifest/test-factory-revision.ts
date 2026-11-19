import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  captureIdentity,
  resolveTarget,
  treeStatus,
  describeDirty,
  identityHolds,
  lockfileDigest,
  changedFiles,
  diffStat,
  fileAt,
  existsAt,
} from "./factory/revision.ts";
import { assert, throws, makeRepo, sh, cleanup } from "./factory/testkit.ts";

function commit(root: string, msg: string): string {
  sh("git", ["add", "-A"], root);
  sh("git", ["commit", "-q", "-m", msg], root);
  return sh("git", ["rev-parse", "HEAD"], root);
}

function run() {
  console.log("Identity\n");

  const root = makeRepo({ branch: "main" });
  const base = sh("git", ["rev-parse", "HEAD"], root);
  sh("git", ["checkout", "-q", "-b", "feature"], root);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  const head = commit(root, "a");

  {
    const id = captureIdentity(root, "main");
    assert(id.head_sha === head && id.target_sha === base && id.merge_base_sha === base, "head, target tip and merge base");
    sh("git", ["update-ref", "refs/remotes/origin/main", head], root);
    assert(resolveTarget(root, "main") === head, "origin/{ref} is preferred over the local branch");
    sh("git", ["update-ref", "-d", "refs/remotes/origin/main"], root);
    throws(() => resolveTarget(root, "develop"), /no_target/, "a missing target is blocked");
  }

  console.log("\nClean tree\n");

  {
    assert(treeStatus(root).clean, "a committed tree is clean");
    writeFileSync(join(root, "SCRATCHPAD_61.md"), "notes\n");
    const s = treeStatus(root);
    assert(!s.clean && s.untracked.join() === "SCRATCHPAD_61.md", "an untracked scratchpad makes the tree dirty");
    assert(describeDirty(s).includes(".git/info/exclude"), "the message names the .git/info/exclude fix");
    appendFileSync(join(root, ".git", "info", "exclude"), "SCRATCHPAD_*.md\n");
    assert(treeStatus(root).clean, "listing it in .git/info/exclude makes the tree clean");

    mkdirSync(join(root, "deep", "er"), { recursive: true });
    writeFileSync(join(root, "deep", "er", "x.txt"), "x\n");
    assert(treeStatus(root).untracked.join() === "deep/er/x.txt", "untracked files are listed one by one, not by directory");
    rmSync(join(root, "deep"), { recursive: true });

    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    const m = treeStatus(root);
    assert(m.modified.join() === "a.ts" && describeDirty(m).startsWith("uncommitted changes to a.ts"), "a tracked modification is listed");
    assert(!identityHolds(root, head).ok, "identity fails on a dirty tree");
    sh("git", ["checkout", "-q", "--", "a.ts"], root);
    assert(identityHolds(root, head).ok, "identity holds on a clean tree at head");
    sh("git", ["commit", "-q", "--allow-empty", "-m", "moved"], root);
    assert(/HEAD is/.test(identityHolds(root, head).detail), "identity fails when HEAD moved, even on a clean tree");
  }

  console.log("\nLockfiles\n");

  {
    assert(lockfileDigest(root) === null, "no lockfile → null");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    commit(root, "lock");
    const d1 = lockfileDigest(root)!;
    assert(/^sha256:[0-9a-f]{64}$/.test(d1), "a tracked lockfile has a digest");
    mkdirSync(join(root, "pkg"));
    writeFileSync(join(root, "pkg", "Cargo.lock"), "# cargo\n");
    writeFileSync(join(root, "notes.lock"), "x\n");
    commit(root, "nested lock");
    const d2 = lockfileDigest(root)!;
    assert(d2 !== d1, "a nested lockfile counts");
    writeFileSync(join(root, "notes.lock"), "y\n");
    commit(root, "other");
    assert(lockfileDigest(root) === d2, "other files don't change it");
    writeFileSync(join(root, "package-lock.json"), '{"v":2}\n');
    commit(root, "bump");
    assert(lockfileDigest(root) !== d2, "a changed lockfile does");
    assert(lockfileDigest(root, base) === null, "it can be read at any revision");
  }

  console.log("\nChanged files\n");

  {
    const r = makeRepo();
    writeFileSync(join(r, "keep.ts"), "1\n");
    writeFileSync(join(r, "gone.ts"), "1\n");
    writeFileSync(join(r, "old.test.ts"), "it('x', () => {});\n");
    const b = commit(r, "base");
    writeFileSync(join(r, "keep.ts"), "2\n");
    rmSync(join(r, "gone.ts"));
    sh("git", ["mv", "old.test.ts", "new.test.ts"], r);
    writeFileSync(join(r, "added.ts"), "1\n");
    const h = commit(r, "change");
    const files = changedFiles(r, b, h).map((f) => `${f.status}:${f.path}`).join(" ");
    assert(files === "A:added.ts D:gone.ts M:keep.ts A:new.test.ts D:old.test.ts", "added, deleted, modified; a rename is a delete plus an add");
    assert(fileAt(r, b, "gone.ts") === "1\n" && fileAt(r, h, "gone.ts") === null, "fileAt reads a revision's content");
    assert(existsAt(r, b, "old.test.ts") && !existsAt(r, h, "old.test.ts"), "existsAt");
  }

  console.log("\nDiff size\n");

  {
    const r = makeRepo();
    writeFileSync(join(r, "a.ts"), "1\n2\n3\n");
    writeFileSync(join(r, "moved.ts"), "x\ny\n");
    const b = commit(r, "base");
    writeFileSync(join(r, "a.ts"), "1\nTWO\n3\n4\n"); // 2 added, 1 removed
    writeFileSync(join(r, "img.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    sh("git", ["mv", "moved.ts", "renamed.ts"], r); // 2 removed + 2 added
    const h = commit(r, "change");
    const s = diffStat(r, b, h);
    assert(
      s.files === 4 && s.lines === 7 && diffStat(r, h, h).files === 0 && diffStat(r, h, h).lines === 0,
      "diffStat counts files and added plus removed lines, a binary file as a file with no lines",
    );
  }

  console.log("\nAll factory revision tests passed.");
}

try {
  run();
} finally {
  cleanup();
}
