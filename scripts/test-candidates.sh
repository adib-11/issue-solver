#!/usr/bin/env bash
# Checks the solve-issue candidate filter against a fixture GraphQL response.
# Run from anywhere: bash scripts/test-candidates.sh
set -eu
cd "$(dirname "$0")/.."

out=$(jq -f skills/solve-issue/scripts/candidates.jq scripts/fixtures/issues.json)

check() { jq -e "$1" <<<"$out" >/dev/null || { echo "FAIL: $1"; echo "$out"; exit 1; }; }
check '[.[].number] == [1, 4]'
check '.[0] == {number: 1, title: "Free", url: "u1", labels: ["good first issue"], comments: 2,
                maintainerLastCommentAt: "2026-08-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", body: "Crash when X"}'
check '.[1].body == "" and .[1].maintainerLastCommentAt == null'
echo OK
