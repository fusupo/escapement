#!/usr/bin/env bash
#
# Tests for worktree.sh (#88): worktrees go to
# ${XDG_DATA_HOME:-~/.local/share}/escapement/worktrees/{owner}-{repo}/{name}.
#
# npm is a stub on PATH that logs its arguments, so nothing is installed
# and no network is used.
#
# Usage: bash scripts/test-worktree.sh
#

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/worktree.sh"
pass=0
fail=0

ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL $*"; }
expect_eq() { if [[ "$2" == "$3" ]]; then ok; else bad "$1: '$2' (want '$3')"; fi; }

g() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/home"
cat > "$tmp/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$NPM_LOG"
[[ -z "${NPM_FAIL:-}" ]]
EOF
chmod +x "$tmp/bin/npm"
export PATH="$tmp/bin:$PATH" NPM_LOG="$tmp/npm.log" HOME="$tmp/home" XDG_DATA_HOME="$tmp/xdg"
unset NPM_FAIL
: > "$NPM_LOG"

wt() { bash "$script" "$@"; }

# A repository with an origin on GitHub.
main="$tmp/src/main"
mkdir -p "$main/sub"
g init -q -b main "$main"
g -C "$main" remote add origin https://github.com/o/r.git
echo hi > "$main/README.md"
g -C "$main" add README.md
g -C "$main" commit -q -m init
base="$tmp/xdg/escapement/worktrees/o-r"

# path
expect_eq "path" "$(cd "$main" && wt path foo)" "$base/foo"
expect_eq "path from a subdirectory" "$(cd "$main/sub" && wt path foo)" "$base/foo"
expect_eq "a / in the name becomes -" "$(cd "$main" && wt path feat/x)" "$base/feat-x"
expect_eq "without XDG_DATA_HOME, ~/.local/share" "$(cd "$main" && XDG_DATA_HOME= wt path foo)" "$tmp/home/.local/share/escapement/worktrees/o-r/foo"

# add: a new branch named after the worktree; the path is the last stdout line.
out="$(cd "$main" && wt add foo 2>/dev/null)"
expect_eq "add prints the path" "$(tail -n 1 <<< "$out")" "$base/foo"
expect_eq "add creates a branch named after it" "$(git -C "$base/foo" branch --show-current)" "foo"
expect_eq "npm is not run for another project" "$(cat "$NPM_LOG")" ""

# add with -b, a commit-ish and the option after the name.
out="$(cd "$main" && wt add feat/x main -b feat/x 2>/dev/null)"
expect_eq "add -b" "$(git -C "$base/feat-x" branch --show-current 2>/dev/null)" "feat/x"

# The README's form: the option first, then the name and a ref; detached.
out="$(cd "$main" && wt add --detach pinned main 2>/dev/null)"
expect_eq "add --detach NAME REF prints the path" "$(tail -n 1 <<< "$out")" "$base/pinned"
[[ -z "$(git -C "$base/pinned" branch --show-current 2>/dev/null)" && -n "$(git -C "$base/pinned" rev-parse HEAD 2>/dev/null)" ]] && ok || bad "pinned worktree is not detached"

# From inside a linked worktree, the same place.
expect_eq "path from a linked worktree" "$(cd "$base/foo" && wt path foo)" "$base/foo"

# An existing worktree is reported, not recreated.
err="$(cd "$main" && wt add foo 2>&1 >/dev/null)"; status=$?
out="$(cd "$main" && wt add foo 2>/dev/null)"
expect_eq "add again exits 0" "$status" "0"
expect_eq "add again prints the path" "$out" "$base/foo"
[[ "$err" == *"already exists"* ]] && ok || bad "add again says it exists: '$err'"

# A path that exists but is not a worktree of this repository is refused.
mkdir -p "$base/stray"
(cd "$main" && wt add stray >/dev/null 2>&1) && bad "add over a stray directory succeeded" || ok

# list marks managed worktrees.
listing="$(cd "$main" && wt list)"
grep -Fxq "* $base/foo  foo" <<< "$listing" && ok || bad "list marks foo: $listing"
grep -Fq "  $main  main" <<< "$listing" && ok || bad "list shows the main checkout unmarked: $listing"
grep -Fq "* $base/pinned  (detached)" <<< "$listing" && ok || bad "list shows a detached worktree: $listing"

# Bad names create nothing.
for name in ../x /abs a/../b . ""; do
  (cd "$main" && wt add "$name" >/dev/null 2>&1) && bad "name '$name' accepted" || ok
done
[[ ! -e "$tmp/xdg/escapement/worktrees/x" ]] && ok || bad "a ../ name escaped the base directory"

# remove: git's dirty-tree refusal stands; --force removes; the branch stays.
echo dirt > "$base/foo/dirt"
(cd "$main" && wt remove foo >/dev/null 2>&1) && bad "removed a dirty worktree without --force" || ok
(cd "$main" && wt remove foo --force >/dev/null 2>&1) && ok || bad "remove --force"
[[ ! -e "$base/foo" ]] && ok || bad "foo is still there"
g -C "$main" rev-parse --verify -q refs/heads/foo >/dev/null && ok || bad "remove deleted the branch"
(cd "$main" && wt remove nothing-here >/dev/null 2>&1) && bad "removed a worktree that isn't there" || ok

# Outside git: refused.
mkdir "$tmp/plain"
(cd "$tmp/plain" && wt path foo >/dev/null 2>&1) && bad "path outside git succeeded" || ok

# No origin: the main checkout's directory name.
mkdir -p "$tmp/src/lonely"
g init -q -b main "$tmp/src/lonely"
expect_eq "no origin" "$(cd "$tmp/src/lonely" && wt path x)" "$tmp/xdg/escapement/worktrees/lonely/x"

# An ssh origin.
g -C "$tmp/src/lonely" remote add origin git@github.com:acme/widgets.git
expect_eq "ssh origin" "$(cd "$tmp/src/lonely" && wt path x)" "$tmp/xdg/escapement/worktrees/acme-widgets/x"

# Escapement itself: add installs the runner's dependencies.
esc="$tmp/src/escapement"
mkdir -p "$esc/.claude-plugin" "$esc/manifest"
g init -q -b develop "$esc"
g -C "$esc" remote add origin https://github.com/fusupo/escapement.git
echo '{ "name": "escapement", "version": "1.0.0" }' > "$esc/.claude-plugin/plugin.json"
echo '{}' > "$esc/manifest/package.json"
g -C "$esc" add -A
g -C "$esc" commit -q -m init
: > "$NPM_LOG"
out="$(cd "$esc" && wt add --detach escapement-plugin develop 2>/dev/null)"; status=$?
epath="$tmp/xdg/escapement/worktrees/fusupo-escapement/escapement-plugin"
expect_eq "Escapement add exits 0" "$status" "0"
expect_eq "Escapement add prints the path last" "$(tail -n 1 <<< "$out")" "$epath"
expect_eq "Escapement add runs npm ci" "$(cat "$NPM_LOG")" "ci --prefix $epath/manifest"

# A failed install fails the add but leaves the worktree.
: > "$NPM_LOG"
(cd "$esc" && NPM_FAIL=1 wt add second develop -b second >/dev/null 2>&1) && bad "a failed npm ci passed" || ok
[[ -d "$tmp/xdg/escapement/worktrees/fusupo-escapement/second/manifest" ]] && ok || bad "the worktree was not left in place"

echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
