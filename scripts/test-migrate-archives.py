#!/usr/bin/env python3
"""Tests for parse_context_path in migrate-archives.py.

Uses the shared fixtures in scripts/fixtures/context-path/ (see
scripts/test-get-context-path.sh for the format).

Usage: python3 scripts/test-migrate-archives.py
"""

import importlib.util
import sys
from pathlib import Path

# Loading migrate-archives.py would otherwise leave scripts/__pycache__ behind.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures" / "context-path"

spec = importlib.util.spec_from_file_location("migrate_archives", HERE / "migrate-archives.py")
migrate_archives = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate_archives)


def check(name, text, expected, expected_warnings):
    warnings = []
    got = migrate_archives.parse_context_path(text, warnings.append)
    if got == expected and len(warnings) == expected_warnings:
        return True
    print(f"FAIL {name}: {got!r} with {len(warnings)} warning(s), want {expected!r} with {expected_warnings}")
    return False


def main():
    results = []
    for md in sorted(FIXTURES.glob("*.md")):
        out = md.with_suffix(".out").read_text().rstrip("\n")
        warn = int(md.with_suffix(".warn").read_text().strip())
        # newline="" keeps CRLF line endings as they are on disk
        text = md.open(newline="").read()
        results.append(check(md.stem, text, out or None, warn))
    results.append(check("escapement CLAUDE.md", (HERE.parent / "CLAUDE.md").read_text(), "../escapement-ctx", 0))

    passed = sum(results)
    print(f"{passed} passed, {len(results) - passed} failed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
