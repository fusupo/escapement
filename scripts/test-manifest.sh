#!/usr/bin/env bash
#
# Tests for manifest.sh. Every CLI run uses a temporary --data-dir, so the
# real manifest database is never opened.
#
# Usage: bash scripts/test-manifest.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wrapper="$here/manifest.sh"
pass=0
fail=0

ok()   { pass=$((pass + 1)); }
bad()  { fail=$((fail + 1)); echo "FAIL $1"; [[ -n "${2:-}" ]] && sed 's/^/    /' <<<"$2"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A stand-in for some other project: no package.json, no node_modules.
project="$tmp/project"
mkdir -p "$project/ctx/manifest" "$tmp/data"

# --check with dependencies installed
if (cd "$project" && bash "$wrapper" --check) >/dev/null 2>&1; then ok; else bad "check-installed"; fi

# status from another project's directory
out="$(cd "$project" && bash "$wrapper" --data-dir "$tmp/data" status 2>&1)"
if [[ $? -eq 0 && "$out" == *"Total items: 0"* ]]; then ok; else bad "status-from-other-cwd" "$out"; fi

# A relative seed path resolves against the caller's cwd
cat > "$project/ctx/manifest/seed.sql" <<'EOF'
INSERT INTO work_items (id, name, kind) VALUES ('t1', 'Test item', 'issue');
EOF
out="$(cd "$project" && bash "$wrapper" --data-dir "$tmp/data" seed ctx/manifest/seed.sql 2>&1)"
if [[ $? -eq 0 ]]; then ok; else bad "seed-relative-path" "$out"; fi
out="$(cd "$project" && bash "$wrapper" --data-dir "$tmp/data" status 2>&1)"
if [[ "$out" == *"Total items: 1"* ]]; then ok; else bad "seed-applied" "$out"; fi

# Exit status passes through (no command -> usage, exit 1)
(cd "$project" && bash "$wrapper" --data-dir "$tmp/data") >/dev/null 2>&1
if [[ $? -ne 0 ]]; then ok; else bad "exit-status-passthrough"; fi

# Missing dependencies: a copy of the plugin layout without node_modules
fake="$tmp/fake-plugin"
mkdir -p "$fake/scripts" "$fake/manifest"
cp "$wrapper" "$fake/scripts/"
touch "$fake/manifest/manifest-cli.ts"
for args in "--check" "status"; do
  err="$(cd "$project" && bash "$fake/scripts/manifest.sh" $args 2>&1 >/dev/null)"
  status=$?
  if [[ $status -ne 0 && "$err" == *"cd '$fake/manifest' && npm ci"* ]]; then ok; else bad "missing-deps ($args)" "$err"; fi
done

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
