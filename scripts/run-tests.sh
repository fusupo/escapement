#!/usr/bin/env bash
#
# run-tests.sh
#
# Escapement's test runner and its factory `verify` command: every suite
# (manifest/test-*.ts, scripts/test-*.sh, scripts/test-*.py), one at a
# time, with JUnit XML for the factory (manifest/run-suites.ts).
#
# Usage:
#   bash scripts/run-tests.sh [--junit <path>] [suite ...]
#
# The JUnit file goes to --junit, else $FACTORY_RESULTS_DIR/junit.xml when
# the factory sets it. Naming suites (paths from the repo root) runs only
# those. Exit 1 if any suite failed.
#

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tsx="$root/manifest/node_modules/tsx/dist/esm/index.mjs"

if [[ ! -f "$tsx" ]]; then
  echo "run-tests: dependencies are not installed. Run:" >&2
  echo "  cd '$root/manifest' && npm ci" >&2
  exit 1
fi

exec node --import "$tsx" "$root/manifest/run-suites.ts" "$@"
