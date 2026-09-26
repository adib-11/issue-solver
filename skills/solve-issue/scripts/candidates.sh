#!/usr/bin/env bash
# Prints open issues of <owner>/<repo> that are unassigned and have no linked or mentioning open PR, as JSON.
# Usage: bash candidates.sh <owner>/<repo> [limit]
set -euo pipefail
repo=${1:?usage: candidates.sh <owner>/<repo> [limit]}
limit=${2:-50}
[[ $repo =~ ^[^/]+/[^/]+$ ]] || { echo "expected <owner>/<repo>, got: $repo" >&2; exit 2; }
(( limit >= 1 && limit <= 100 )) || { echo "limit must be 1-100" >&2; exit 2; }

gh api graphql \
  -f owner="${repo%%/*}" -f name="${repo#*/}" -F limit="$limit" \
  -f query='
query($owner: String!, $name: String!, $limit: Int!) {
  repository(owner: $owner, name: $name) {
    issues(first: $limit, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url body updatedAt
        labels(first: 20) { nodes { name } }
        assignees { totalCount }
        comments(last: 20) { totalCount nodes { authorAssociation createdAt } }
        closedByPullRequestsReferences(first: 10) { nodes { state } }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 20) {
          nodes { ... on CrossReferencedEvent { isCrossRepository source { ... on PullRequest { state } } } }
        }
      }
    }
  }
}' | jq -f "$(dirname "$0")/candidates.jq"
