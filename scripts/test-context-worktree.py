#!/usr/bin/env python3
"""Tests for detect_context_path in migrate-archives.py from linked worktrees (#88).

Runs the worktree cases at the top of scripts/fixtures/context-path.md
(format described there) against a real repository: the main checkout in one
temporary directory, and a linked worktree nested in another, so it sits
outside the repository's parent directory. Each case must give the same
directory from the worktree, a subdirectory of it, the main checkout and a
subdirectory of that. The same cases run against get-context-path.sh
(scripts/test-context-worktree.sh) and the runner
(manifest/test-context-worktree.ts).

Usage: python3 scripts/test-context-worktree.py
"""

import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Loading migrate-archives.py would otherwise leave scripts/__pycache__ behind.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
CASES = HERE / "fixtures" / "context-path.md"
WORKTREE_RE = re.compile(r"^=== worktree: (.*?) \| expect: ?(.*?)\s*$")

spec = importlib.util.spec_from_file_location("migrate_archives", HERE / "migrate-archives.py")
migrate_archives = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate_archives)


def git(*args, cwd):
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false",
         "-c", "core.hooksPath=/dev/null", *args],
        cwd=cwd, check=True, capture_output=True,
    )


def load_worktree_cases():
    cases = []
    for line in CASES.read_text().split("\n"):
        if line.startswith("=== case: "):
            break
        m = WORKTREE_RE.match(line)
        if m:
            cases.append({"name": m[1], "expect": m[2], "body": []})
        elif cases:
            cases[-1]["body"].append(line)
    return cases


def main():
    cases = load_worktree_cases()
    if len(cases) < 5:
        print(f"FAIL: only {len(cases)} worktree cases parsed from {CASES}")
        return 1

    tmp = Path(tempfile.mkdtemp()).resolve()
    far = Path(tempfile.mkdtemp()).resolve()
    results = []

    def check(name, got, expected):
        got = "" if got is None else str(got)
        if got == expected:
            results.append(True)
        else:
            print(f"FAIL {name}: {got!r}, want {expected!r}")
            results.append(False)

    try:
        # The committed CLAUDE.md (what the worktree gets) sets ../wrong-ctx;
        # each case then writes the main checkout's own copy.
        parent = tmp / "repo"
        main_dir = parent / "main"
        (main_dir / "sub" / "deeper").mkdir(parents=True)
        git("init", "-q", "-b", "main", cwd=main_dir)
        (main_dir / "CLAUDE.md").write_text("## Escapement Settings\n\n- **context-path**: ../wrong-ctx\n")
        git("add", "CLAUDE.md", cwd=main_dir)
        git("commit", "-q", "-m", "init", cwd=main_dir)
        wt = far / "a" / "b" / "wt"
        git("worktree", "add", "-q", "-b", "88-wt", str(wt), cwd=main_dir)
        (wt / "sub").mkdir()
        if parent in wt.parents:
            print("FAIL: the worktree must be outside the repository's parent")
            return 1

        check("main_checkout from the worktree", migrate_archives.main_checkout(wt), str(main_dir))
        check("main_checkout from a main checkout subdirectory",
              migrate_archives.main_checkout(main_dir / "sub" / "deeper"), str(main_dir))

        for c in cases:
            (main_dir / "CLAUDE.md").write_text("\n".join(c["body"]))
            expected = c["expect"].replace("{main}", str(main_dir)).replace("{parent}", str(parent))
            for where, d in [
                ("worktree", wt),
                ("worktree subdirectory", wt / "sub"),
                ("main checkout", main_dir),
                ("main checkout subdirectory", main_dir / "sub" / "deeper"),
            ]:
                check(f"{c['name']} from the {where}", migrate_archives.detect_context_path(d), expected)

        # A worktree of a bare repository has no main checkout: it stands in.
        git("clone", "-q", "--bare", str(main_dir), str(tmp / "bare.git"), cwd=tmp)
        git("worktree", "add", "-q", str(far / "bare-wt"), "main", cwd=tmp / "bare.git")
        check("bare repository worktree", migrate_archives.main_checkout(far / "bare-wt"), str(far / "bare-wt"))

        # Outside git the directory itself stands in.
        plain = tmp / "plain"
        plain.mkdir()
        (plain / "CLAUDE.md").write_text("## Escapement Settings\n\n- **context-path**: ../plain-ctx\n")
        check("outside git", migrate_archives.detect_context_path(plain), str(tmp / "plain-ctx"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(far, ignore_errors=True)

    passed = sum(results)
    print(f"{passed} passed, {len(results) - passed} failed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
