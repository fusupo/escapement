#!/usr/bin/env python3
"""Tests for parse_context_path in migrate-archives.py.

Uses the shared cases in scripts/fixtures/context-path.md (format described
at the top of that file).

Usage: python3 scripts/test-migrate-archives.py
"""

import importlib.util
import re
import sys
from pathlib import Path

# Loading migrate-archives.py would otherwise leave scripts/__pycache__ behind.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
CASES = HERE / "fixtures" / "context-path.md"
CASE_RE = re.compile(r"^=== case: (.*?) \| expect: ?(.*?) \| warnings: (\d+)\s*$")

spec = importlib.util.spec_from_file_location("migrate_archives", HERE / "migrate-archives.py")
migrate_archives = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate_archives)


def load_cases():
    cases = []
    for line in CASES.read_text().split("\n"):
        m = CASE_RE.match(line)
        if m:
            cases.append({"name": m[1], "expect": m[2].strip() or None, "warnings": int(m[3]), "body": []})
        elif cases:
            cases[-1]["body"].append(line)
    return cases


def check(name, text, expected, expected_warnings):
    warnings = []
    got = migrate_archives.parse_context_path(text, warnings.append)
    if got == expected and len(warnings) == expected_warnings:
        return True
    print(f"FAIL {name}: {got!r} with {len(warnings)} warning(s), want {expected!r} with {expected_warnings}")
    return False


def main():
    cases = load_cases()
    if not cases:
        print(f"FAIL: no cases parsed from {CASES}")
        return 1
    results = [check(c["name"], "\n".join(c["body"]), c["expect"], c["warnings"]) for c in cases]

    # Whitespace-sensitive cases, built here so editors can't strip them.
    results.append(check("crlf", "## Escapement Settings\r\n\r\n- **context-path**: ../crlf-ctx\r\n", "../crlf-ctx", 0))
    results.append(check("trailing-whitespace", "## Escapement Settings\n\n- **context-path**: ../trailing-ctx   \t\n", "../trailing-ctx", 0))
    results.append(check("escapement CLAUDE.md", (HERE.parent / "CLAUDE.md").read_text(), "../escapement-ctx", 0))

    passed = sum(results)
    print(f"{passed} passed, {len(results) - passed} failed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
