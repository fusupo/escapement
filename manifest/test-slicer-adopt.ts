// The slicer's adopt subcommand (#89): archive-work brings a session log the
// PreCompact hook wrote into another worktree's root into this one, through
// scripts/slice-session-log.sh, so SESSION_LOG_*.jsonl files are still only
// ever written by the slicer. Each case runs the real script.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./factory/testkit.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SLICER = join(repoRoot, "scripts", "slice-session-log.sh");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "slicer-adopt-")));
const state = join(tmp, "state");
const env = { ...process.env, XDG_STATE_HOME: state };

function slicer(...args: string[]) {
  const r = spawnSync("bash", [SLICER, ...args], { env, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

const ls = (dir: string) => readdirSync(dir).sort().join(",");
const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => JSON.stringify({ sessionId: tag, n: i + 1 })).join("\n") + "\n";

try {
  console.log("slice-session-log.sh adopt\n");

  // Another worktree's root holds a hook log; this root already has logs 1
  // (.jsonl) and 2 (a converted .md), so the next free number is 3.
  const other = join(tmp, "other-worktree");
  const here = join(tmp, "this-worktree");
  mkdirSync(other);
  mkdirSync(here);
  const hookLog = join(other, "SESSION_LOG_1.jsonl");
  writeFileSync(hookLog, lines(4, "s-other"));
  writeFileSync(join(here, "SESSION_LOG_1.jsonl"), lines(1, "s-here"));
  writeFileSync(join(here, "SESSION_LOG_2.md"), "# converted\n");

  // A transcript with a cursor, to show adopt leaves cursors alone.
  const transcript = join(tmp, "11111111-1111-1111-1111-111111111111.jsonl");
  writeFileSync(transcript, lines(6, "s-other"));
  const cursorFile = join(state, "escapement", "session-cursors", "11111111-1111-1111-1111-111111111111");
  const committed = slicer("commit", transcript, "4");
  const cursorBefore = readFileSync(cursorFile, "utf-8");
  const cursorsBefore = ls(dirname(cursorFile));

  const adopted = slicer("adopt", hookLog, here);
  const movedOk =
    adopted.status === 0 &&
    adopted.stdout === `FILE=${join(here, "SESSION_LOG_3.jsonl")}` &&
    !existsSync(hookLog) &&
    readFileSync(join(here, "SESSION_LOG_3.jsonl"), "utf-8") === lines(4, "s-other") &&
    ls(here) === "SESSION_LOG_1.jsonl,SESSION_LOG_2.md,SESSION_LOG_3.jsonl";
  const cursorUntouched =
    committed.status === 0 &&
    readFileSync(cursorFile, "utf-8") === cursorBefore &&
    ls(dirname(cursorFile)) === cursorsBefore;

  // Failures: the source stays where it was, and nothing is written.
  const second = join(other, "SESSION_LOG_2.jsonl");
  writeFileSync(second, lines(2, "s-other"));
  const missingDir = slicer("adopt", second, join(tmp, "no-such-dir"));
  const readOnly = join(tmp, "read-only");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o555);
  const unwritable = slicer("adopt", second, readOnly);
  chmodSync(readOnly, 0o755);
  const notALog = join(other, "notes.jsonl");
  writeFileSync(notALog, lines(1, "x"));
  const wrongName = slicer("adopt", notALog, here);
  const noSource = slicer("adopt", join(other, "SESSION_LOG_9.jsonl"), here);
  // Running as root ignores the read-only mode; then the move succeeds and
  // only the other failures can be checked.
  const rootUser = process.getuid?.() === 0;
  const failuresKeepSource =
    missingDir.status === 1 &&
    /output directory not found/.test(missingDir.stderr) &&
    (rootUser || (unwritable.status === 1 && /failed to move/.test(unwritable.stderr) && ls(readOnly) === "")) &&
    (rootUser || existsSync(second)) &&
    wrongName.status === 1 &&
    /not a session log/.test(wrongName.stderr) &&
    existsSync(notALog) &&
    noSource.status === 1 &&
    ls(here) === "SESSION_LOG_1.jsonl,SESSION_LOG_2.md,SESSION_LOG_3.jsonl";

  assert(
    movedOk && cursorUntouched && failuresKeepSource,
    "adopt moves a hook log to the next free number, skipping .jsonl and .md numbers, never touches a cursor, and leaves the source in place on failure",
  );

  // The usage line names adopt, so a typo'd subcommand points at it.
  const usage = slicer("adpot");
  assert(usage.status === 1 && usage.stderr.includes("adopt LOG OUTDIR"), "the slicer's usage line lists adopt LOG OUTDIR");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
