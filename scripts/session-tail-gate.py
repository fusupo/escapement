#!/usr/bin/env python3
"""
session-tail-gate.py

Decides whether a session-log slice is this issue's work, so archive-work
can include it without asking (#123). archive-work's Phase 1.5 runs it on
the session tail; #89 (archive every session that worked on the issue) can
run it on each session's slice the same way.

Usage:
  python3 -I session-tail-gate.py FILE --branch <current branch>
                                       --base <base branch> --root <worktree root>

FILE is a slice of a Claude Code transcript (JSONL). Each entry records the
git branch (`gitBranch`) and directory (`cwd`) it happened in. With B the
issue branch (--branch) and f the first entry on B, the slice is included
when:

  - every entry from f on is on B;
  - every entry before f is on a detached HEAD (`HEAD`) or the base branch
    (setup-work often starts there, before the issue branch exists);
  - every entry before f that records a `cwd` is in this worktree: --root
    or a directory below it, but not inside another worktree nested there.

Anything else is a question for the operator: another named branch
anywhere, HEAD or base-branch entries after f, a `cwd` outside the
worktree, or no entry on B at all. When there is no issue branch to anchor
on (--branch is empty, a detached HEAD, or is the base branch itself, as
when archiving from develop after a merge), the old rule applies: include
only when every entry is on the current branch. Entries without a
`gitBranch` don't count, and lines that aren't JSON are skipped.

Prints one JSON line:
  {"decision": "include" | "ask", "reason": ..., "branches": {...},
   "first": <first timestamp or "-">, "last": <last timestamp or "-">}

Exit 0 with a decision; 2 on a usage error or an unreadable FILE.
"""

import argparse
import collections
import json
import os
import sys

DETACHED = "HEAD"


def norm(path):
    """An absolute, normalized path; symlinks resolved when the path exists."""
    path = os.path.abspath(path)
    return os.path.realpath(path) if os.path.exists(path) else os.path.normpath(path)


def in_worktree(cwd, root):
    """True when cwd is root or below it, and not inside a worktree nested there."""
    cwd, root = norm(cwd), norm(root)
    if cwd == root:
        return True
    if os.path.commonpath([cwd, root]) != root:
        return False
    # A directory between root and cwd that has its own .git is another
    # worktree (or repository) nested inside this one.
    d = cwd
    while d != root:
        if os.path.exists(os.path.join(d, ".git")):
            return False
        d = os.path.dirname(d)
    return True


def read_entries(path):
    entries, times = [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            if entry.get("timestamp"):
                times.append(entry["timestamp"])
            if entry.get("gitBranch"):
                entries.append((entry["gitBranch"], entry.get("cwd") or None))
    return entries, times


def decide(entries, branch, base, root):
    names = {b for b, _ in entries}
    if not entries:
        return "include", "no_branch_recorded"
    if not branch or branch == base:
        if names == {branch}:
            return "include", "current_branch_only"
        return "ask", "no_issue_branch"
    first = next((i for i, (b, _) in enumerate(entries) if b == branch), None)
    if first is None:
        return "ask", "issue_branch_absent"
    for b, _ in entries[first:]:
        if b != branch:
            if b in (DETACHED, base):
                return "ask", "head_or_base_after_issue_branch"
            return "ask", "other_branch"
    for b, cwd in entries[:first]:
        if b not in (DETACHED, base):
            return "ask", "other_branch"
        if cwd and not in_worktree(cwd, root):
            return "ask", "outside_worktree"
    if first == 0:
        return "include", "current_branch_only"
    return "include", "setup_before_issue_branch"


def main():
    parser = argparse.ArgumentParser(description="Decide whether a session-log slice is this issue's work.")
    parser.add_argument("file")
    parser.add_argument("--branch", required=True, help="the current branch; empty on a detached HEAD")
    parser.add_argument("--base", required=True, help="the project's base branch")
    parser.add_argument("--root", required=True, help="the worktree's top-level directory")
    args = parser.parse_args()
    if not args.base or not args.root:
        parser.error("--base and --root must not be empty")
    try:
        entries, times = read_entries(args.file)
    except OSError as e:
        print(f"session-tail-gate: {e}", file=sys.stderr)
        sys.exit(2)
    decision, reason = decide(entries, args.branch, args.base, args.root)
    branches = dict(collections.Counter(b for b, _ in entries))
    print(json.dumps({
        "decision": decision,
        "reason": reason,
        "branches": branches,
        "first": times[0] if times else "-",
        "last": times[-1] if times else "-",
    }))


if __name__ == "__main__":
    main()
