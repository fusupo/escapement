#!/usr/bin/env python3
"""
find-session-transcripts.py

Finds the Claude Code sessions that worked on an issue, so archive-work can
archive every one of them without a compaction first (#89). Slicing and
cursors stay with scripts/slice-session-log.sh, and whether a slice is the
issue's work stays with scripts/session-tail-gate.py: this script finds the
sessions and runs those two for archive-work's Phase 1.6.

Usage (run with python3 -I, from the worktree being archived):
  find-session-transcripts.py find    --branch B --base BASE [options]
  find-session-transcripts.py prepare --branch B --base BASE [options]
  find-session-transcripts.py finish  [--pending FILE] [--include KEY[,KEY...]]

Options for find and prepare:
  --exclude-session ID   the session running archive-work (Phase 1.5 has it)
  --extra-worktree PATH  a factory run's worktree_path, even if it was removed
                         (repeatable)
  --managed-base DIR     the directory scripts/worktree.sh keeps this
                         repository's worktrees in
  --runs-json FILE|-     `factory.sh --json status --all`'s output, from a
                         file or stdin: every recorded run's worktree_path
                         for this repository is one of its worktrees (#129)
  --since TS --until TS  the run's started_at and ended_at
  --claude-dir DIR       default ${CLAUDE_CONFIG_DIR:-~/.claude}
  --outdir DIR           where slices go (default: the current directory)
  --pending FILE         default: $(git rev-parse --git-path
                         escapement-session-pending.json)
  --slicer, --gate       the scripts to run (default: next to this one)

Where transcripts are looked for: Claude Code keeps a session's transcript
in {claude-dir}/projects/{encoded cwd}/{session id}.jsonl, where the encoded
cwd is the path with every character that isn't a letter or digit turned
into "-" (so "/.local" becomes "--local"). A name over 200 characters is
cut and given a suffix, so a long name is matched by its first 200.

Only this repository's directories are searched (#129). Its worktrees are
the main checkout, every worktree in `git worktree list` (prunable ones
included), every --extra-worktree, and every recorded run's worktree_path
for this repository (--runs-json): transcripts outlive their worktrees. The
directories searched are those worktrees' own, plus every directory whose
name starts with the encoded --managed-base and a "-", for removed managed
worktrees. Because the encoding is lossy ("/" and "-" both become "-"), a
name can't tell this repository's worktrees from a sibling repository's
(`worktrees/o-r/foo` and `worktrees/o-r-foo` encode the same), so a
transcript is kept only when its first recorded cwd is at or below one of
those worktrees or --managed-base. A removed worktree nothing records (a
pruned, pre-#88 sibling) is no longer found. Only the *.jsonl files
directly inside are read; subagent transcripts, in subdirectories, are
never archived.

Which are kept: a transcript is the issue's when an entry ran on the issue
branch (gitBranch == B), or when an entry ran in an issue worktree (a listed
worktree other than the main checkout with B checked out, or an
--extra-worktree: its root or a directory below it) at a time inside
[--since, --until]. Without --since the second rule is off: a worktree path
can be reused by later runs, so only the run's own time counts.

find prints {"branch", "sessions": [...], "hook_logs": [...]}. Each session
is {session_id, transcript, root, branches, first, last, size, lines},
sorted by first timestamp. root is the worktree the session ran in, for the
gate: the longest known worktree path holding its first cwd, else
{managed-base}/{name} for a removed managed worktree, else that cwd. A hook
log is a SESSION_LOG_*.jsonl in another existing worktree's root that
belongs to a kept session.

prepare (Phase 1.6 block A) slices each session into --outdir without moving
its cursor, skips those with nothing new, gates each slice and each hook log
(where it is), and writes the pending file: {version, branch, base, outdir,
entries: [{key, kind: "slice" | "hook_log", session_id, transcript, file,
start, end, lines, size, decision, reason, branches, first, last, root}]}.
It prints the same JSON. A pending file left by an earlier prepare is
cleared first: its slices were never committed, so they are removed.

finish (block B) takes the operator's choice. An entry whose decision is
"include", or whose key is in --include, is kept: a slice's cursor is
committed, and a hook log is adopted into the outdir. Any other slice is
removed with its cursor left, so the next log picks it up; any other hook
log stays where it is. It prints one line per entry and removes the
pending file. With no pending file it prints "nothing pending".

Exit 0 on success; 1 when a slice, commit or adopt failed (finish reports
each and goes on); 2 on a usage error.
"""

import argparse
import collections
import datetime
import glob
import importlib.util
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_NAME = 200
PENDING_NAME = "escapement-session-pending.json"
SLICE_LINE = re.compile(r"^FILE=(.*) START=(\d+) END=(\d+) LINES=(\d+)$")


def load_gate_rules():
    """norm and in_worktree from session-tail-gate.py, so both scripts share one rule."""
    # No __pycache__ next to the scripts: it would dirty the checkout.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("session_tail_gate", os.path.join(HERE, "session-tail-gate.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.norm, module.in_worktree


norm, in_worktree = load_gate_rules()


def fail(message, code=2):
    print(f"find-session-transcripts: {message}", file=sys.stderr)
    sys.exit(code)


def encode(path):
    """Claude Code's project directory name for a path."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def exact_match(name, encoded):
    return name == encoded if len(encoded) <= MAX_NAME else name.startswith(encoded[:MAX_NAME])


def prefix_match(name, encoded):
    return name.startswith((encoded + "-")[:MAX_NAME])


def at_or_below(path, root):
    path, root = norm(path), norm(root)
    return path == root or os.path.commonpath([path, root]) == root


def parse_time(value):
    if not value:
        return None
    try:
        t = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=datetime.timezone.utc)


def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if r.returncode != 0:
        fail(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def worktrees():
    """[{path, branch}] from git worktree list; the main checkout comes first."""
    items, current = [], None
    for line in git("worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            current = {"path": line[len("worktree "):], "branch": None, "bare": False}
            items.append(current)
        elif current and line.startswith("branch refs/heads/"):
            current["branch"] = line[len("branch refs/heads/"):]
        elif current and line == "bare":
            current["bare"] = True
    return items


def repo_name(main):
    """owner/name from main's origin URL, else main's basename.

    The same rule as repoName in manifest/factory/context.ts, which names
    the runs' repo: keep the two in step.
    """
    r = subprocess.run(["git", "-C", main, "config", "--get", "remote.origin.url"], capture_output=True, text=True)
    url = r.stdout.strip() if r.returncode == 0 else ""
    m = re.search(r"[:/]([^/:]+)/([^/]+?)(?:\.git)?/?$", url) if url else None
    return f"{m.group(1)}/{m.group(2)}" if m else os.path.basename(os.path.normpath(main))


def recorded_worktrees(source, repo):
    """worktree_path of every run of `repo` in `factory status --all` JSON (a path or "-")."""
    if not source:
        return []
    try:
        text = sys.stdin.read() if source == "-" else open(source, encoding="utf-8").read()
        runs = (json.loads(text).get("result") or {}).get("runs") or []
    except (OSError, ValueError, AttributeError):
        return []
    return [r["worktree_path"] for r in runs if isinstance(r, dict) and r.get("repo") == repo and r.get("worktree_path")]


def pending_default():
    path = git("rev-parse", "--git-path", PENDING_NAME)
    return os.path.abspath(path)


def candidate_dirs(projects, exact, prefixes):
    try:
        names = sorted(os.listdir(projects))
    except OSError:
        return []
    exact = {encode(p) for p in exact}
    prefixes = {encode(p) for p in prefixes if p}
    return [
        os.path.join(projects, name)
        for name in names
        if os.path.isdir(os.path.join(projects, name))
        and (any(exact_match(name, e) for e in exact) or any(prefix_match(name, p) for p in prefixes))
    ]


def scan(path, branch, issue_roots, since, until):
    """The transcript's summary, or None when it isn't the issue's."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return None
    # Cheap first pass: a transcript that never names the branch or an issue
    # worktree can't be kept, and most aren't.
    needles = [json.dumps(branch)]
    if since:
        needles += [json.dumps(r)[1:-1] for r in issue_roots]
    if not any(n in text for n in needles):
        return None

    keep = False
    branches = collections.Counter()
    times = []
    first_cwd = None
    for line in text.splitlines():
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        stamp = entry.get("timestamp")
        if stamp:
            times.append(stamp)
        b = entry.get("gitBranch")
        if b:
            branches[b] += 1
            if b == branch:
                keep = True
        cwd = entry.get("cwd")
        if cwd and first_cwd is None:
            first_cwd = cwd
        if not keep and cwd and since and issue_roots:
            t = parse_time(stamp)
            if t and since <= t and (until is None or t <= until) and any(in_worktree(cwd, r) for r in issue_roots):
                keep = True
    if not keep:
        return None
    return {
        "branches": dict(branches),
        "first": times[0] if times else "-",
        "last": times[-1] if times else "-",
        "first_cwd": first_cwd,
        "size": len(text.encode("utf-8")),
        "lines": text.count("\n"),
    }


def root_for(cwd, known, managed_base, fallback):
    """The worktree a session ran in, for the gate's --root. Never empty."""
    if not cwd:
        return fallback
    containing = [p for p in known if at_or_below(cwd, p)]
    if containing:
        return max(containing, key=lambda p: len(norm(p)))
    if managed_base and at_or_below(cwd, managed_base) and norm(cwd) != norm(managed_base):
        name = os.path.relpath(norm(cwd), norm(managed_base)).split(os.sep)[0]
        return os.path.join(managed_base, name)
    return cwd


def session_of_log(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(entry, dict) and entry.get("sessionId"):
                    return entry["sessionId"]
    except OSError:
        pass
    return None


def find(args):
    since = parse_time(args.since) if args.since else None
    until = parse_time(args.until) if args.until else None
    if args.since and not since:
        fail(f"--since is not a timestamp: {args.since!r}")
    if args.until and not until:
        fail(f"--until is not a timestamp: {args.until!r}")

    listed = [w for w in worktrees() if not w["bare"]]
    if not listed:
        fail("no worktrees listed")
    main = listed[0]["path"]
    here = norm(git("rev-parse", "--show-toplevel"))
    extra = [p for p in args.extra_worktree if p]
    issue_roots = [w["path"] for w in listed[1:] if w["branch"] == args.branch] + extra
    recorded = recorded_worktrees(args.runs_json, repo_name(main))
    known = [w["path"] for w in listed] + extra + recorded
    # A kept transcript must have started in one of these (#129)
    allowed = known + ([args.managed_base] if args.managed_base else [])

    exact = set(known)
    exact |= {os.path.realpath(p) for p in known if os.path.exists(p)}
    prefixes = [args.managed_base]
    projects = os.path.join(args.claude_dir, "projects")

    sessions = []
    seen = set()
    for directory in candidate_dirs(projects, exact, prefixes):
        for transcript in sorted(glob.glob(os.path.join(directory, "*.jsonl"))):
            session_id = os.path.basename(transcript)[: -len(".jsonl")]
            if session_id == args.exclude_session or transcript in seen:
                continue
            seen.add(transcript)
            info = scan(transcript, args.branch, issue_roots, since, until)
            if not info:
                continue
            cwd = info.pop("first_cwd")
            if not cwd or not any(at_or_below(cwd, r) for r in allowed):
                continue
            sessions.append({
                "session_id": session_id,
                "transcript": transcript,
                "root": root_for(cwd, known, args.managed_base, main),
                **info,
            })
    sessions.sort(key=lambda s: (parse_time(s["first"]) or datetime.datetime.max.replace(tzinfo=datetime.timezone.utc), s["session_id"]))

    kept = {s["session_id"]: s for s in sessions}
    hook_logs = []
    for w in listed:
        if norm(w["path"]) == here or not os.path.isdir(w["path"]):
            continue
        for log in sorted(glob.glob(os.path.join(w["path"], "SESSION_LOG_*.jsonl"))):
            session_id = session_of_log(log)
            if session_id in kept and session_id != args.exclude_session:
                hook_logs.append({"file": log, "session_id": session_id, "root": w["path"]})
    return {"branch": args.branch, "sessions": sessions, "hook_logs": hook_logs}


def run_gate(args, path, root):
    r = subprocess.run(
        [sys.executable, "-I", args.gate, path, "--branch", args.branch, "--base", args.base, "--root", root],
        capture_output=True,
        text=True,
    )
    try:
        return json.loads(r.stdout) if r.returncode == 0 else None
    except json.JSONDecodeError:
        return None


def count_lines(path):
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def clear_stale(pending):
    """Remove the uncommitted slices an unfinished prepare left behind."""
    try:
        with open(pending, encoding="utf-8") as f:
            stale = json.load(f)
    except (OSError, json.JSONDecodeError):
        stale = {}
    for entry in stale.get("entries", []):
        if entry.get("kind") == "slice" and entry.get("file") and os.path.isfile(entry["file"]):
            os.remove(entry["file"])
    os.remove(pending)
    print(f"find-session-transcripts: cleared an unfinished earlier prepare ({pending})", file=sys.stderr)


def prepare(args):
    pending = args.pending or pending_default()
    if os.path.exists(pending):
        clear_stale(pending)
    found = find(args)
    outdir = os.path.abspath(args.outdir)
    entries, errors = [], []

    def add(kind, session_id, path, root, extra):
        verdict = run_gate(args, path, root)
        entries.append({
            "key": f"{session_id[:8]}:{len(entries) + 1}",
            "kind": kind,
            "session_id": session_id,
            "file": path,
            "root": root,
            "size": os.path.getsize(path),
            "decision": verdict["decision"] if verdict else "ask",
            "reason": verdict["reason"] if verdict else "gate_failed",
            "branches": verdict["branches"] if verdict else {},
            "first": verdict["first"] if verdict else "-",
            "last": verdict["last"] if verdict else "-",
            **extra,
        })

    for s in found["sessions"]:
        r = subprocess.run(["bash", args.slicer, "slice", s["transcript"], outdir, "--no-advance"], capture_output=True, text=True)
        out = r.stdout.strip()
        if r.returncode != 0:
            errors.append(f"session {s['session_id'][:8]}: {r.stderr.strip()}")
            continue
        if out == "EMPTY":
            continue
        m = SLICE_LINE.match(out)
        if not m:
            errors.append(f"session {s['session_id'][:8]}: unexpected slicer output {out!r}")
            continue
        add("slice", s["session_id"], m.group(1), s["root"], {
            "transcript": s["transcript"],
            "start": int(m.group(2)),
            "end": int(m.group(3)),
            "lines": int(m.group(4)),
        })
    for log in found["hook_logs"]:
        add("hook_log", log["session_id"], log["file"], log["root"], {
            "transcript": None,
            "start": None,
            "end": None,
            "lines": count_lines(log["file"]),
        })

    doc = {"version": 1, "branch": args.branch, "base": args.base, "outdir": outdir, "pending": pending,
           "entries": entries, "errors": errors}
    tmp = f"{pending}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, pending)
    print(json.dumps(doc, indent=2))
    return 1 if errors else 0


def finish(args):
    pending = args.pending or pending_default()
    if not os.path.exists(pending):
        print("nothing pending")
        return 0
    with open(pending, encoding="utf-8") as f:
        doc = json.load(f)
    entries = doc.get("entries", [])
    include = {k.strip() for k in (args.include or "").split(",") if k.strip()}
    unknown = include - {e["key"] for e in entries}
    if unknown:
        fail(f"unknown key(s) in --include: {', '.join(sorted(unknown))}")
    outdir = doc.get("outdir") or os.path.abspath(".")
    failed = False

    for e in entries:
        chosen = e["decision"] == "include" or e["key"] in include
        id8 = e["session_id"][:8]
        if e["kind"] == "slice":
            name = os.path.basename(e["file"])[: -len(".jsonl")]
            if chosen:
                r = subprocess.run(["bash", args.slicer, "commit", e["transcript"], str(e["end"])], capture_output=True, text=True)
                if r.returncode == 0:
                    print(f"{name} <- session {id8} ({e['root']}, lines {e['start']}-{e['end']})")
                else:
                    failed = True
                    print(f"{name} <- session {id8}: cursor not committed: {r.stderr.strip()}")
            else:
                if os.path.isfile(e["file"]):
                    os.remove(e["file"])
                print(f"declined: session {id8} ({e['root']}, {e['lines']} lines), left for a later log")
        else:
            if chosen:
                r = subprocess.run(["bash", args.slicer, "adopt", e["file"], outdir], capture_output=True, text=True)
                m = re.match(r"^FILE=(.*)$", r.stdout.strip())
                if r.returncode == 0 and m:
                    name = os.path.basename(m.group(1))[: -len(".jsonl")]
                    print(f"{name} <- session {id8} ({e['root']}, hook log {os.path.basename(e['file'])})")
                else:
                    failed = True
                    print(f"hook log {e['file']} (session {id8}) not adopted: {r.stderr.strip()}")
            else:
                print(f"declined: hook log {e['file']} (session {id8}), left in its worktree")
    os.remove(pending)
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description="Find and slice the sessions that worked on an issue.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("find", "prepare"):
        p = sub.add_parser(name)
        p.add_argument("--branch", required=True)
        p.add_argument("--base", required=True)
        p.add_argument("--exclude-session", default="")
        p.add_argument("--extra-worktree", action="append", default=[])
        p.add_argument("--managed-base", default="")
        p.add_argument("--runs-json", default="")
        p.add_argument("--since", default="")
        p.add_argument("--until", default="")
        p.add_argument("--claude-dir", default=os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"))
        p.add_argument("--outdir", default=".")
        p.add_argument("--pending", default="")
        p.add_argument("--slicer", default=os.path.join(HERE, "slice-session-log.sh"))
        p.add_argument("--gate", default=os.path.join(HERE, "session-tail-gate.py"))
    p = sub.add_parser("finish")
    p.add_argument("--pending", default="")
    p.add_argument("--include", default="")
    p.add_argument("--slicer", default=os.path.join(HERE, "slice-session-log.sh"))
    args = parser.parse_args()

    if args.command in ("find", "prepare"):
        if not args.branch or not args.base:
            parser.error("--branch and --base must not be empty")
        if args.branch == args.base:
            parser.error("--branch is the base branch: there is no issue branch to search for")
    if args.command == "find":
        print(json.dumps(find(args), indent=2))
        return 0
    if args.command == "prepare":
        return prepare(args)
    return finish(args)


if __name__ == "__main__":
    sys.exit(main())
