# solve-issue

An Agent Skills bundle that walks you from "I want to fix something" to an opened pull request: pick a GitHub issue, brief it, implement it test-first, review it, and push after your approval. Run it with `solve-issue`. It is user-invoked only; no harness starts it on its own.

Requires the [`gh` CLI](https://cli.github.com), logged in (`gh auth login`), plus `git` and `bash`.

## Install

Replace `<owner>/issue-solver` with the GitHub repo this bundle is published at.

### skills.sh (Codex, Claude Code, Cursor, and other Agent Skills harnesses)

```bash
npx skills add <owner>/issue-solver
```

Pick your harness when prompted, or pass `-a <agent>` (for example `-a codex`). All skills in `skills/` install together; `solve-issue` depends on the others.

### Claude Code plugin

In Claude Code:

```
/plugin marketplace add <owner>/issue-solver
/plugin install solve-issue@issue-solver
```

For a local checkout, start Claude Code with `claude --plugin-dir /path/to/issue-solver`.

### Manual

Copy every directory under `skills/` into your harness's skills directory (for example `~/.codex/skills/` or `~/.claude/skills/`).

## Run

- **Claude Code:** `/solve-issue` (as a plugin: `/solve-issue:solve-issue`).
- **Codex:** `$solve-issue`, or pick it from `/skills`.
- **Other harnesses:** invoke the `solve-issue` skill the way that harness runs user-invoked skills.

## Harness metadata

- `SKILL.md` frontmatter `disable-model-invocation: true` keeps Claude Code from invoking `solve-issue` and `implement` on its own.
- `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` for the same skills in Codex.
- Code review runs its two reviews with whatever sub-agent mechanism the harness has, or one after the other if it has none.

`bash scripts/check-skills.sh` checks all of this, and checks that no `SKILL.md` names a Claude Code-only tool.
