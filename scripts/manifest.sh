#!/usr/bin/env bash
#
# manifest.sh
#
# Runs the manifest CLI (manifest/manifest-cli.ts) from any working
# directory. Skills call it as:
#
#   bash "${CLAUDE_PLUGIN_ROOT}/scripts/manifest.sh" status
#
# The plugin root is found from this script's own location, and tsx is
# loaded from manifest/node_modules by absolute path, so the caller's
# project needs no package.json or node_modules. The working directory is
# left unchanged, so relative file arguments (e.g. `seed {context-path}/...`)
# resolve against the caller's project root.
#
# Usage:
#   manifest.sh --check            Exit 0 if the CLI's dependencies are
#                                  installed; otherwise print how to install
#                                  them and exit 1. Opens no database.
#   manifest.sh [CLI args...]      Run the CLI (see `manifest.sh` with no
#                                  arguments for its usage).
#

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$root/manifest/manifest-cli.ts"
tsx="$root/manifest/node_modules/tsx/dist/esm/index.mjs"

if [[ ! -f "$cli" ]]; then
  echo "manifest: CLI not found at $cli" >&2
  exit 1
fi

if [[ ! -f "$tsx" ]]; then
  echo "manifest: dependencies are not installed. Run:" >&2
  echo "  cd '$root/manifest' && npm ci" >&2
  echo "(needs Node.js and a C/C++ build toolchain for better-sqlite3)" >&2
  exit 1
fi

if [[ "${1:-}" == "--check" ]]; then
  exit 0
fi

exec node --import "$tsx" "$cli" "$@"
