import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { git } from "./context.ts";
import { blocked } from "./util.ts";

/**
 * What a validation is bound to (§4.3), read from git. Nothing here
 * fetches: the target is whatever the worktree's refs say it is.
 */

export type Identity = {
  head_sha: string;
  target_ref: string;
  target_sha: string;
  merge_base_sha: string;
};

/** The target's tip: `origin/{ref}` when the remote-tracking ref exists, else the local branch. */
export function resolveTarget(worktree: string, targetRef: string): string {
  for (const ref of [`refs/remotes/origin/${targetRef}`, `refs/heads/${targetRef}`]) {
    try {
      return git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], worktree);
    } catch {
      // try the next one
    }
  }
  throw blocked("no_target", `target branch ${targetRef} not found (neither origin/${targetRef} nor a local ${targetRef})`);
}

export function captureIdentity(worktree: string, targetRef: string): Identity {
  const head_sha = git(["rev-parse", "HEAD"], worktree);
  const target_sha = resolveTarget(worktree, targetRef);
  let merge_base_sha: string;
  try {
    merge_base_sha = git(["merge-base", head_sha, target_sha], worktree);
  } catch {
    throw blocked("no_merge_base", `HEAD has no common history with ${targetRef}`);
  }
  return { head_sha, target_ref: targetRef, target_sha, merge_base_sha };
}

export type TreeStatus = {
  clean: boolean;
  /** Tracked files with staged or unstaged changes. */
  modified: string[];
  /** Untracked files not ignored by .gitignore or .git/info/exclude. */
  untracked: string[];
};

/** Tracked changes and unignored untracked files, listed by path (§4.3 clean tree). */
export function treeStatus(worktree: string): TreeStatus {
  const out = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: worktree,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const modified: string[] = [];
  const untracked: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    const path = e.slice(3);
    if (code === "??") untracked.push(path);
    else modified.push(path);
    // A rename or copy is followed by its source path.
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return { clean: modified.length === 0 && untracked.length === 0, modified, untracked };
}

/** One line for a dirty tree: what is dirty and, for untracked files, the fix. */
export function describeDirty(s: TreeStatus, max = 5): string {
  const list = (paths: string[]) => paths.slice(0, max).join(", ") + (paths.length > max ? `, … (${paths.length} in all)` : "");
  const parts: string[] = [];
  if (s.modified.length) parts.push(`uncommitted changes to ${list(s.modified)}`);
  if (s.untracked.length) {
    parts.push(`untracked ${list(s.untracked)} (commit them, or list working files in .git/info/exclude)`);
  }
  return parts.join("; ");
}

/** HEAD still equals `headSha` and the tree is clean (§4.3). */
export function identityHolds(worktreePath: string, headSha: string): { ok: boolean; detail: string } {
  let head: string;
  let status: TreeStatus;
  try {
    head = git(["rev-parse", "HEAD"], worktreePath);
    status = treeStatus(worktreePath);
  } catch (err) {
    return { ok: false, detail: String((err as Error).message) };
  }
  if (head !== headSha) return { ok: false, detail: `HEAD is ${head}, attempt validated ${headSha}` };
  if (!status.clean) return { ok: false, detail: `worktree is not clean: ${describeDirty(status)}` };
  return { ok: true, detail: "" };
}

/** Dependency lockfiles, by file name, anywhere in the tree. */
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
] as const;

/**
 * Digest of the lockfiles tracked at `rev` (§4.3 dependency policy), over
 * their paths and blob IDs, or null when there are none.
 */
export function lockfileDigest(worktree: string, rev = "HEAD"): string | null {
  const out = git(["ls-tree", "-r", "-z", rev], worktree);
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { blob: line.slice(0, tab).split(" ")[2], path: line.slice(tab + 1) };
    })
    .filter((e) => (LOCKFILES as readonly string[]).includes(posix.basename(e.path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (entries.length === 0) return null;
  const h = createHash("sha256");
  for (const e of entries) h.update(`${e.path}\0${e.blob}\n`);
  return `sha256:${h.digest("hex")}`;
}

export type ChangedFile = {
  /** A added, M modified, D deleted, T type change. A rename is a delete plus an add. */
  status: "A" | "M" | "D" | "T";
  path: string;
};

/**
 * Files changed between `base` and `head` (the full branch diff, §4.5).
 * Renames are not detected: a renamed file is its old path deleted and its
 * new path added, which classifies a moved test as modified (§4.6).
 */
export function changedFiles(worktree: string, base: string, head: string): ChangedFile[] {
  const out = execFileSync("git", ["diff", "--name-status", "-z", "--no-renames", base, head], {
    cwd: worktree,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parts = out.split("\0").filter((p) => p !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    const status = code === "A" || code === "D" || code === "T" ? code : "M";
    files.push({ status, path: parts[i + 1] });
  }
  return files;
}

/**
 * The size of the diff `base..head`, for the gate's limits (§6.3, #110):
 * the files changed and the lines added plus removed. Like changedFiles,
 * renames are not detected, so a rename counts its old and new paths. A
 * binary file counts as a file with no lines (git shows `-` for it).
 */
export function diffStat(worktree: string, base: string, head: string): { files: number; lines: number } {
  const out = execFileSync("git", ["diff", "--numstat", "-z", "--no-renames", base, head], {
    cwd: worktree,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let files = 0;
  let lines = 0;
  for (const entry of out.split("\0")) {
    const m = entry.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files += 1;
    lines += (m[1] === "-" ? 0 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
  }
  return { files, lines };
}

/** A file's content at `rev`, or null when it doesn't exist there. */
export function fileAt(worktree: string, rev: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      cwd: worktree,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Whether `path` exists at `rev`. */
export function existsAt(worktree: string, rev: string, path: string): boolean {
  try {
    git(["cat-file", "-e", `${rev}:${path}`], worktree);
    return true;
  } catch {
    return false;
  }
}
