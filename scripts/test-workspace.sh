#!/usr/bin/env bash
# Checks solve-issue's workspace.sh against local bare repos and a stub gh.
# Run from anywhere: bash scripts/test-workspace.sh
set -eu
cd "$(dirname "$0")/.."
ws=$PWD/skills/solve-issue/scripts/workspace.sh
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*"; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

# Branch naming.
source "$ws"
eq "$(branch_name 7 'Crash when X!' 'bug,good first issue')" "fix/7-crash-when-x" "bug label"
eq "$(branch_name 8 'Add --json flag' 'Enhancement')" "feat/8-add-json-flag" "enhancement label"
eq "$(branch_name 9 'Typo in README' 'documentation')" "docs/9-typo-in-readme" "docs label"
eq "$(branch_name 10 'Debug output is noisy' 'debugger,dockerfile')" "fix/10-debug-output-is-noisy" "no label match"
eq "$(branch_name 11 'A very long title that keeps going well past forty characters' '')" \
   "fix/11-a-very-long-title-that-keeps-going-well" "slug length"
eq "$(branch_name 12 '日本語' '')" "fix/12" "empty slug"
eq "$(repo_of git@github.com:Acme/Widget.git)" "Acme/Widget" "ssh url"
eq "$(repo_of https://github.com/acme/widget)" "acme/widget" "https url"
eq "$(repo_of https://me@github.com/acme/widget.git/)" "acme/widget" "https url with user"
eq "$(repo_of git@github-work:acme/widget.git)" "acme/widget" "ssh host alias"
eq "$(repo_of https://gitlab.com/acme/widget.git)" "" "non-GitHub url"
eq "$(url_for me/widget-1 git@github-work:acme/widget.git)" "git@github-work:me/widget-1.git" "url styled after example"

# Fake GitHub: bare repos under $tmp/gh, reached through git's insteadOf.
export GIT_CONFIG_GLOBAL=$tmp/gitconfig GIT_CONFIG_NOSYSTEM=1
git config --global user.name t
git config --global user.email t@t
git config --global init.defaultBranch main
git config --global url."$tmp/gh/".insteadOf https://github.com/
git config --global --add url."$tmp/gh/".insteadOf git@github.com:

git init -q "$tmp/seed"
mkdir -p "$tmp/seed/.github"
echo "Use conventional commits." > "$tmp/seed/CONTRIBUTING.md"
echo "## What" > "$tmp/seed/.github/pull_request_template.md"
git -C "$tmp/seed" add -A
git -C "$tmp/seed" commit -qm init
mkdir -p "$tmp/gh/acme"
git clone -q --bare "$tmp/seed" "$tmp/gh/acme/widget.git"

mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  "repo view acme/widget --json viewerPermission,defaultBranchRef "*) echo "$STUB_PERM main" ;;
  "issue view 7 --repo acme/widget --json title,labels "*) printf 'bug\nCrash when X!\n' ;;
  "repo fork acme/widget --clone=false")
    [ -d "$STUB_GH/$STUB_FORK.git" ] || { mkdir -p "$STUB_GH/me"; git clone -q --bare "$STUB_GH/acme/widget.git" "$STUB_GH/$STUB_FORK.git"; } ;;
  "api graphql -f owner=acme -f name=widget "*) echo "$STUB_FORK" ;;
  "config get git_protocol"*) echo https ;;
  "repo set-default acme/widget") ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/bin/gh"
export PATH=$tmp/bin:$PATH STUB_GH=$tmp/gh STUB_LOG=$tmp/gh.log STUB_FORK=me/widget

run() { : > "$STUB_LOG"; out=$(bash "$ws" acme/widget 7 "$1") || fail "workspace.sh exited non-zero for $1"; }
refuses() { # dir expected-error
  local err
  err=$(bash "$ws" acme/widget 7 "$1" 2>&1) && fail "accepted $1"
  grep -qF "$2" <<<"$err" || fail "$1: expected error '$2', got: $err"
}
field() { jq -r "$1" <<<"$out"; }
check_ready() { # dir branch
  eq "$(git -C "$1" branch --show-current)" "$2" "current branch in $1"
  eq "$(git -C "$1" status --porcelain)" "" "clean tree in $1"
  eq "$(git -C "$1" rev-parse HEAD)" "$(git -C "$tmp/gh/acme/widget.git" rev-parse main)" "branch starts at upstream main"
}
url() { git -C "$1" config --get "remote.$2.url"; }

# 1. No push access, no clone: fork, origin = fork, upstream = original.
export STUB_PERM=READ
run "$tmp/a"
eq "$(field .mode)" fork "mode"
eq "$(field .dir)" "$(cd "$tmp/a" && pwd -P)" "dir"
eq "$(url "$tmp/a" origin)" https://github.com/me/widget.git "origin"
eq "$(url "$tmp/a" upstream)" https://github.com/acme/widget.git "upstream"
eq "$(field '.pushRemote + " " + .syncRemote')" "origin upstream" "remotes in output"
eq "$(field .cloned)" true "cloned"
eq "$(field '.guidelines | join(" ")')" ".github/pull_request_template.md CONTRIBUTING.md" "guidelines"
[ -d "$tmp/gh/me/widget.git" ] || fail "fork not created"
check_ready "$tmp/a" fix/7-crash-when-x

# 2. Rerun on the same clone after upstream moved: reuse, sync, same branch.
git -C "$tmp/a" switch -q main
git -C "$tmp/seed" commit -q --allow-empty -m upstream-moved
git -C "$tmp/seed" push -q "$tmp/gh/acme/widget.git" main
git -C "$tmp/a" branch -q -D fix/7-crash-when-x
run "$tmp/a"
eq "$(field .cloned)" false "reused clone"
eq "$(git -C "$tmp/a" remote | sort | tr '\n' ' ')" "origin upstream " "no duplicate remotes"
check_ready "$tmp/a" fix/7-crash-when-x

# 3. Existing branch is reused, not recreated.
git -C "$tmp/a" switch -q main
run "$tmp/a"
eq "$(field .branchExisted)" true "existing branch reused"
eq "$(git -C "$tmp/a" branch --show-current)" fix/7-crash-when-x "switched to existing branch"

# 4. Existing clone of the original (origin = acme): origin becomes upstream, fork added as origin.
git clone -q https://github.com/acme/widget.git "$tmp/b"
run "$tmp/b"
eq "$(url "$tmp/b" origin)" https://github.com/me/widget.git "origin after rename"
eq "$(url "$tmp/b" upstream)" https://github.com/acme/widget.git "upstream after rename"
check_ready "$tmp/b" fix/7-crash-when-x

# 5. SSH clone: the fork remote keeps the SSH style.
git clone -q git@github.com:acme/widget.git "$tmp/s"
run "$tmp/s"
eq "$(url "$tmp/s" origin)" git@github.com:me/widget.git "ssh origin"
eq "$(url "$tmp/s" upstream)" git@github.com:acme/widget.git "ssh upstream"

# 6. A fork under another name is found, not guessed.
rm -rf "$tmp/gh/me"
STUB_FORK=me/widget-fork run "$tmp/e"
eq "$(field .fork)" me/widget-fork "renamed fork"
eq "$(url "$tmp/e" origin)" https://github.com/me/widget-fork.git "origin for renamed fork"
check_ready "$tmp/e" fix/7-crash-when-x

# 7. Push access: no fork, origin = original.
export STUB_PERM=WRITE
run "$tmp/c"
eq "$(field .mode)" direct "mode"
grep -q "repo fork" "$STUB_LOG" && fail "forked despite push access"
eq "$(git -C "$tmp/c" remote)" origin "only origin"
eq "$(field '.pushRemote + " " + .syncRemote')" "origin origin" "direct remotes"
check_ready "$tmp/c" fix/7-crash-when-x

# 8. Dirty tree is refused and left alone.
git -C "$tmp/c" switch -q main
echo wip > "$tmp/c/wip.txt"
refuses "$tmp/c" "uncommitted changes"
eq "$(git -C "$tmp/c" branch --show-current)" main "dirty tree untouched"

# 9. A directory that is not a clone of the repo is refused.
mkdir "$tmp/d" && git init -q "$tmp/d" && git -C "$tmp/d" remote add origin https://github.com/other/thing.git
refuses "$tmp/d" "no remote pointing at acme/widget"

# 10. Bad input exits 2.
rc=0; bash "$ws" acme 7 "$tmp/x" 2>/dev/null || rc=$?
eq "$rc" 2 "bad repo exit code"

echo OK
