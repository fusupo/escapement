import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./util.ts";
import { attemptDir } from "./attempts.ts";
import { changedFiles } from "./revision.ts";
import { settingsAt } from "./classify.ts";
import { parseFactorySettings } from "./settings.ts";
import { firstMatch } from "./glob.ts";
import type { Contract } from "./schemas.ts";
import type { Report } from "./validate.ts";

/**
 * The review phase (docs/FACTORY_DESIGN.md §4.9): what a complete verdict
 * must cover, and the read-only source snapshot the reviewer reads.
 */

// ── required judgments ───────────────────────────────────────────────

export type JudgmentKind = "supports_criterion" | "procedure_adequate";

export type RequiredJudgments = {
  /** Every contract evidence item, judged exactly once. */
  evidence: {
    id: string;
    criterion_id: string;
    criterion: string;
    type: "test" | "command" | "manual";
    kind: string;
    judgment: JudgmentKind;
    /** The runner's deterministic result from the draft report. */
    executed: string;
    /** The selector, command or instructions the contract gives. */
    spec: string;
  }[];
  /** Every changed sensitive path and every execution-policy change, signed off. */
  sensitive_paths: { path: string; reasons: string[] }[];
  /** Every modified-assertion location from phase 1, justified. */
  modified_assertions: { location: string; detail: string }[];
};

/** Executable evidence is judged on whether it supports its criterion; manual evidence on whether its procedure would. */
export function judgmentFor(type: string): JudgmentKind {
  return type === "manual" ? "procedure_adequate" : "supports_criterion";
}

/**
 * What a complete verdict for this attempt must cover. Computed only from
 * the contract, the draft report and git at the attempt's revisions, so
 * `review-input` and `record-review` always agree.
 *
 * Sensitive paths are changed files matching `sensitive-paths` at either
 * revision (as in validate), plus each `policy:{path}` finding: execution
 * policy changes make the run sensitive (§4.5), so they need a sign-off too.
 */
export function requiredJudgments(opts: {
  worktree: string;
  contract: Contract;
  draft: Report;
}): RequiredJudgments {
  const { worktree, contract, draft } = opts;
  const executed = new Map(draft.evidence.map((e) => [e.id, e.executed]));
  const evidence = contract.criteria.flatMap((c) =>
    c.evidence.map((e) => ({
      id: e.id,
      criterion_id: c.id,
      criterion: c.text,
      type: e.type,
      kind: e.kind,
      judgment: judgmentFor(e.type),
      executed: executed.get(e.id) ?? "not_run",
      spec: e.type === "test" ? e.selector : e.type === "command" ? e.run : e.instructions,
    })),
  );

  const patterns = (rev: string) => parseFactorySettings(settingsAt(worktree, rev)).settings.sensitivePaths;
  const sensitive = [...new Set([...patterns(draft.merge_base_sha), ...patterns(draft.head_sha)])];
  const reasons = new Map<string, string[]>();
  const add = (path: string, reason: string) => reasons.set(path, [...(reasons.get(path) ?? []), reason]);
  for (const f of changedFiles(worktree, draft.merge_base_sha, draft.head_sha)) {
    const pattern = firstMatch(f.path, sensitive);
    if (pattern) add(f.path, `sensitive path (matches ${pattern})`);
  }
  const modified: RequiredJudgments["modified_assertions"] = [];
  for (const f of draft.findings) {
    if (f.id.startsWith("policy:")) add(f.id.slice("policy:".length), f.detail);
    else if (f.id.startsWith("assertion:")) modified.push({ location: f.id.slice("assertion:".length), detail: f.detail });
  }
  const sensitive_paths = [...reasons.keys()].sort().map((path) => ({ path, reasons: reasons.get(path)! }));
  return { evidence, sensitive_paths, modified_assertions: modified };
}

// ── the source snapshot ──────────────────────────────────────────────

/** `attempts/{n}/review/`: the bundle the reviewer reads. */
export function reviewDir(artifactDir: string, attempt: number): string {
  return join(attemptDir(artifactDir, attempt), "review");
}

/**
 * Export `rev` with `git archive` into `dir` (replacing anything there) and
 * make its files read-only. Directories stay writable so the snapshot can
 * be replaced or cleaned up; the digest catches any change.
 */
export function exportSnapshot(worktree: string, rev: string, dir: string): string {
  removeSnapshot(dir);
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync("git", ["archive", "--format=tar", rev], { cwd: worktree, maxBuffer: 2 ** 31 - 1 });
  if (archive.status !== 0) {
    throw new FactoryError("git_failed", `git archive ${rev} failed: ${archive.stderr?.toString().trim() || archive.error?.message}`);
  }
  const tar = spawnSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive.stdout, maxBuffer: 2 ** 31 - 1 });
  if (tar.status !== 0) {
    throw new FactoryError("snapshot_failed", `extracting the snapshot failed: ${tar.stderr?.toString().trim() || tar.error?.message}`);
  }
  for (const f of walk(dir)) {
    const st = lstatSync(join(dir, f));
    if (st.isFile()) chmodSync(join(dir, f), st.mode & 0o111 ? 0o555 : 0o444);
  }
  return snapshotDigest(dir);
}

export function removeSnapshot(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/** Paths of the files and symlinks under `dir`, relative and `/`-separated, sorted. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * `sha256:` over every file's path, type (executable, plain or symlink) and
 * content digest, in path order. Recomputable at any time, so a changed
 * snapshot is detectable.
 */
export function snapshotDigest(dir: string): string {
  const h = createHash("sha256");
  for (const rel of walk(dir)) {
    const full = join(dir, rel);
    const st = lstatSync(full);
    const [type, content] = st.isSymbolicLink()
      ? ["link", Buffer.from(readlinkSync(full))]
      : [st.mode & 0o111 ? "exec" : "file", readFileSync(full)];
    h.update(`${rel}\0${type}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return `sha256:${h.digest("hex")}`;
}
