#!/usr/bin/env bash
# Prepares <dir> for work on issue <number> of <owner>/<repo>: forks when the user has no push
# access, clones or reuses a clone, syncs the default branch, and switches to the feature branch.
# Prints a JSON summary. Usage: bash workspace.sh <owner>/<repo> <number> <dir>
set -euo pipefail

die() { echo "workspace.sh: $*" >&2; exit 1; }
lc() { tr 'A-Z' 'a-z' <<<"$1"; }
same_repo() { [ "$(lc "$1")" = "$(lc "$2")" ]; }

# owner/repo of a GitHub remote URL (https, ssh, or an ssh host alias containing "github"); empty otherwise.
repo_of() { case $1 in *github*) sed -E 's#/$##; s#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#' <<<"$1" ;; esac; }

# First remote of the current clone whose URL points at <owner>/<repo>; empty if none.
remote_for() {
  local r
  for r in $(git remote); do
    if same_repo "$(repo_of "$(git config --get "remote.$r.url")")" "$1"; then echo "$r"; return; fi
  done
}

# Clone URL for <owner>/<repo>: in the style of <example-url> if given, else per gh's git_protocol.
url_for() {
  if [ -n "${2:-}" ]; then
    sed -E "s#/\$##; s#\\.git\$##; s#[^/:]+/[^/:]+\$#$1.git#" <<<"$2"
  elif [ "$(gh config get git_protocol -h github.com 2>/dev/null || true)" = ssh ]; then
    echo "git@github.com:$1.git"
  else
    echo "https://github.com/$1.git"
  fi
}

# Adds remote <name> for <owner>/<repo>, styled after remote <example>; dies if <name> is taken.
add_remote() {
  git config --get "remote.$1.url" >/dev/null && die "remote $1 already points elsewhere; rename it, then rerun"
  git remote add "$1" "$(url_for "$2" "$(git config --get "remote.$3.url")")"
}

has_label() { grep -Eq "(^|[^a-z])($2)([^a-z]|\$)" <<<"$1"; }

# fix/<number>-<slug>, with feat/ or docs/ when the labels say so.
branch_name() {
  local type=fix labels slug
  labels=$(lc "$3")
  if has_label "$labels" 'bug|fix|regression'; then type=fix
  elif has_label "$labels" 'feat|feature|enhancement'; then type=feat
  elif has_label "$labels" 'docs?|documentation'; then type=docs
  fi
  slug=$(lc "$2" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-40 | sed -E 's/-+$//')
  echo "$type/$1${slug:+-$slug}"
}

# The viewer's fork of <owner>/<repo>, whatever it is named; retries while GitHub creates it.
find_fork() {
  local fork try
  for try in 1 2 3 4 5 6; do
    fork=$(gh api graphql -f owner="${1%%/*}" -f name="${1#*/}" -f query='
      query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          forks(first: 1, affiliations: [OWNER], ownerAffiliations: [OWNER]) { nodes { nameWithOwner } }
        }
      }' --jq '.data.repository.forks.nodes[0].nameWithOwner // empty')
    [ -n "$fork" ] && { echo "$fork"; return; }
    sleep "$try"
  done
  die "could not find your fork of $1 after forking it"
}

main() {
  local repo=${1:?usage: workspace.sh <owner>/<repo> <number> <dir>}
  local number=${2:?usage: workspace.sh <owner>/<repo> <number> <dir>}
  local dir=${3:?usage: workspace.sh <owner>/<repo> <number> <dir>}
  [[ $repo =~ ^[^/]+/[^/]+$ ]] || { echo "expected <owner>/<repo>, got: $repo" >&2; exit 2; }
  [[ $number =~ ^[0-9]+$ ]] || { echo "expected an issue number, got: $number" >&2; exit 2; }

  local info perm default labels title branch
  info=$(gh repo view "$repo" --json viewerPermission,defaultBranchRef --jq '.viewerPermission + " " + .defaultBranchRef.name')
  perm=${info% *} default=${info#* }
  info=$(gh issue view "$number" --repo "$repo" --json title,labels --jq '([.labels[].name] | join(",")), .title')
  labels=${info%%$'\n'*} title=${info#*$'\n'}
  branch=$(branch_name "$number" "$title" "$labels")

  local cloned=false
  if [ -e "$dir" ]; then
    [ "$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" = "$(cd "$dir" && pwd -P)" ] \
      || die "$dir exists and is not the root of a git clone"
  else
    git clone -q "$(url_for "$repo")" "$dir" >&2
    cloned=true
  fi
  cd "$dir"
  [ -z "$(git status --porcelain)" ] || die "$dir has uncommitted changes; commit or stash them first"

  local mode fork="" push sync
  case $perm in
    ADMIN|MAINTAIN|WRITE)
      mode=direct
      sync=$(remote_for "$repo")
      [ -n "$sync" ] || die "$dir has no remote pointing at $repo"
      push=$sync ;;
    *)
      mode=fork
      gh repo fork "$repo" --clone=false >&2
      fork=$(find_fork "$repo")
      sync=$(remote_for "$repo") push=$(remote_for "$fork")
      [ -n "$sync$push" ] || die "$dir has no remote pointing at $repo or $fork"
      if [ -z "$push" ]; then
        [ "$sync" = origin ] && { git remote rename origin upstream; sync=upstream; }
        add_remote origin "$fork" "$sync"
        push=origin
      fi
      if [ -z "$sync" ]; then
        add_remote upstream "$repo" "$push"
        sync=upstream
      fi
      gh repo set-default "$repo" >&2 ;;
  esac

  git fetch -q "$sync"
  if git rev-parse -q --verify "refs/heads/$default" >/dev/null; then
    git switch -q "$default"
    git merge -q --ff-only "$sync/$default" \
      || die "local $default has diverged from $sync/$default; reconcile it, then rerun"
  else
    git switch -q -c "$default" "$sync/$default"
  fi

  local existed=false
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    existed=true
    git switch -q "$branch"
  else
    git switch -q -c "$branch"
  fi

  local guidelines
  guidelines=$({
    find . .github docs -maxdepth 1 -type f \( -iname 'contributing*' -o -iname 'pull_request_template*' -o -iname 'agents.md' \) || true
    find .github docs -maxdepth 2 -type f -ipath '*/pull_request_template/*' || true
  } 2>/dev/null | sed 's#^\./##' | LC_ALL=C sort -u)

  jq -n --arg dir "$(pwd -P)" --arg mode "$mode" --arg fork "$fork" \
    --arg push "$push" --arg sync "$sync" --arg default "$default" --arg branch "$branch" \
    --argjson existed "$existed" --argjson cloned "$cloned" --arg guidelines "$guidelines" \
    '{dir: $dir, mode: $mode, fork: (if $fork == "" then null else $fork end),
      pushRemote: $push, syncRemote: $sync, defaultBranch: $default, branch: $branch,
      branchExisted: $existed, cloned: $cloned,
      guidelines: ($guidelines | split("\n") | map(select(. != "")))}'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
