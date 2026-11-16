import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { resolve, dirname, basename, isAbsolute, join } from "node:path";
import { parseContextPath } from "../init.ts";
import { FactoryError } from "./util.ts";

/**
 * Where a run happens and where its artifacts go.
 *
 * - `worktreePath`: the checkout the run is bound to (§4.3). It is the
 *   --project-root, or the git toplevel of the current directory.
 * - `mainRoot`: the main checkout of the same repository. Linked worktrees
 *   share it, so settings and in-repo artifacts are found in one place and
 *   survive `git worktree remove`.
 */
export type ProjectContext = {
  worktreePath: string;
  mainRoot: string;
  repo: string;
  branch: string;
};

export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new FactoryError("git_failed", `git ${args.join(" ")} failed in ${cwd}${stderr ? `: ${stderr}` : ""}`);
  }
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** The worktree root: --project-root if given, otherwise the git toplevel of `cwd`. */
export function resolveWorktree(projectRoot: string | undefined, cwd: string = process.cwd()): string {
  const start = projectRoot ? resolve(cwd, projectRoot) : cwd;
  if (projectRoot && !(existsSync(start) && statSync(start).isDirectory())) {
    throw new FactoryError("bad_project_root", `--project-root does not exist: ${start}`);
  }
  const top = gitOrNull(["rev-parse", "--show-toplevel"], start);
  if (!top) {
    throw new FactoryError("not_a_repo", `not inside a git work tree: ${start}`);
  }
  return top;
}

/** The main checkout that owns this worktree's repository. */
export function mainRepoRoot(worktreePath: string): string {
  const common = git(["rev-parse", "--git-common-dir"], worktreePath);
  const commonAbs = isAbsolute(common) ? common : resolve(worktreePath, common);
  // A normal repository's common dir is {root}/.git; a bare repository has no
  // main checkout, so the worktree itself stands in for it.
  return basename(commonAbs) === ".git" ? dirname(commonAbs) : worktreePath;
}

/** `owner/repo` from the origin URL, or the main checkout's directory name. */
export function repoName(mainRoot: string): string {
  const url = gitOrNull(["config", "--get", "remote.origin.url"], mainRoot);
  if (url) {
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return basename(mainRoot);
}

export function currentBranch(worktreePath: string): string {
  const branch = git(["branch", "--show-current"], worktreePath);
  if (!branch) {
    throw new FactoryError("detached_head", `worktree is not on a branch (detached HEAD): ${worktreePath}`);
  }
  return branch;
}

/** `develop` when origin has it, otherwise `main`. #60's base-branch setting replaces this. */
export function defaultTargetRef(worktreePath: string): string {
  return gitOrNull(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/develop"], worktreePath)
    ? "develop"
    : "main";
}

export function projectContext(projectRoot: string | undefined, cwd: string = process.cwd()): ProjectContext {
  const worktreePath = resolveWorktree(projectRoot, cwd);
  const mainRoot = mainRepoRoot(worktreePath);
  return { worktreePath, mainRoot, repo: repoName(mainRoot), branch: currentBranch(worktreePath) };
}

export type ArtifactSource = "flag" | "context-path" | "in-repo";

/**
 * Where a run's artifacts go (§4.2). Never inside the tracked tree:
 *
 * 1. `--artifact-dir {dir}`: `{dir}/{run_id}/`
 * 2. context-path from the main checkout's CLAUDE.md:
 *    `{context-path}/{branch}/runs/{run_id}/`
 * 3. otherwise in the main checkout: `.escapement/runs/{branch}/{run_id}/`,
 *    excluded through `.git/info/exclude` so the tree stays clean.
 */
export function resolveArtifactDir(opts: {
  artifactDir?: string;
  ctx: ProjectContext;
  runId: string;
  cwd?: string;
}): { dir: string; source: ArtifactSource } {
  const { ctx, runId } = opts;
  if (opts.artifactDir) {
    return { dir: resolve(opts.cwd ?? process.cwd(), opts.artifactDir, runId), source: "flag" };
  }
  const claudeMd = join(ctx.mainRoot, "CLAUDE.md");
  const contextPath = existsSync(claudeMd) ? parseContextPath(readFileSync(claudeMd, "utf-8")) : null;
  if (contextPath) {
    return { dir: resolve(ctx.mainRoot, contextPath, ctx.branch, "runs", runId), source: "context-path" };
  }
  ensureExcluded(ctx.mainRoot, "/.escapement/");
  return { dir: resolve(ctx.mainRoot, ".escapement", "runs", ctx.branch, runId), source: "in-repo" };
}

/** Add `pattern` to the repository's info/exclude (shared by all its worktrees) unless present. */
export function ensureExcluded(mainRoot: string, pattern: string): void {
  const rel = git(["rev-parse", "--git-path", "info/exclude"], mainRoot);
  const path = isAbsolute(rel) ? rel : resolve(mainRoot, rel);
  const current = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (current.split("\n").some((l) => l.trim() === pattern)) return;
  mkdirSync(dirname(path), { recursive: true });
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${sep}# escapement factory run artifacts\n${pattern}\n`);
}
