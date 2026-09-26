#!/usr/bin/env bash
# Checks every skill is in plugin.json, has Codex metadata, and uses harness-neutral wording.
# Run from anywhere: bash scripts/check-skills.sh
set -u
cd "$(dirname "$0")/.."

fail=0
err() { echo "FAIL: $*"; fail=1; }

for dir in skills/*/; do
  s=$(basename "$dir")
  [ -f "$dir/SKILL.md" ] || { err "$s: no SKILL.md"; continue; }
  grep -q "^name: $s$" "$dir/SKILL.md" || err "$s: frontmatter name does not match directory"
  grep -q "^$s$" <(sed -n 's#.*"\./skills/\(.*\)".*#\1#p' .claude-plugin/plugin.json) || err "$s: not listed in plugin.json"
  [ -f "$dir/agents/openai.yaml" ] || err "$s: no agents/openai.yaml"
  if grep -q "^disable-model-invocation: true" "$dir/SKILL.md"; then
    grep -q "allow_implicit_invocation: false" "$dir/agents/openai.yaml" 2>/dev/null || err "$s: user-invoked only, but openai.yaml allows implicit invocation"
  fi
  # Harness-neutral wording: no Claude Code tool names or slash-command invocations.
  if grep -nE -e "(Skill|Agent|Task) tool|AskUserQuestion|TodoWrite" -e "(^|[ (])/[a-z][a-z-]+" "$dir/SKILL.md"; then
    err "$s: names a harness-specific tool or slash command"
  fi
done

for s in $(sed -n 's#.*"\./skills/\(.*\)".*#\1#p' .claude-plugin/plugin.json); do
  [ -d "skills/$s" ] || err "$s: listed in plugin.json but no skills/$s"
done

[ $fail = 0 ] && echo "OK"
exit $fail
