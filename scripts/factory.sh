#!/usr/bin/env bash
#
# factory.sh
#
# Runs the factory runner CLI (manifest/factory-cli.ts) from any working
# directory. Skills and other hosts (e.g. Escapement Studio) call it as:
#
#   bash "${CLAUDE_PLUGIN_ROOT}/scripts/factory.sh" --json status
#
# The plugin root is found from this script's own location, and tsx is
# loaded from manifest/node_modules by absolute path, so the caller's
# project needs no package.json or node_modules. The working directory is
# left unchanged: it picks the worktree (unless --project-root is given)
# and relative paths such as --contract resolve against it.
#
# Usage:
#   factory.sh --check            Exit 0 if the CLI's dependencies are
#                                 installed; otherwise print how to install
#                                 them and exit 1. Opens no database.
#   factory.sh [CLI args...]      Run the CLI. See docs/FACTORY_CLI.md.
#

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$root/manifest/factory-cli.ts"
tsx="$root/manifest/node_modules/tsx/dist/esm/index.mjs"

if [[ ! -f "$cli" ]]; then
  echo "factory: CLI not found at $cli" >&2
  exit 1
fi

if [[ ! -f "$tsx" ]]; then
  echo "factory: dependencies are not installed. Run:" >&2
  echo "  cd '$root/manifest' && npm ci" >&2
  echo "(needs Node.js and a C/C++ build toolchain for better-sqlite3)" >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  exit 0
fi

exec node --import "$tsx" "$cli" "$@"
