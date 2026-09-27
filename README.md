# solve-issue

An Agent Skills bundle that walks you from "I want to fix something" to an opened pull request: pick a GitHub issue, brief it, implement it test-first, review it, and push after your approval. Run it with `solve-issue`. It is user-invoked only; no harness starts it on its own.

Requires the [`gh` CLI](https://cli.github.com), logged in (`gh auth login`), plus `git` and `bash`.

## Install

### skills.sh (Codex, Claude Code, Cursor, and other Agent Skills harnesses)

```bash
npx skills add adib-11/issue-solver
```

Pick your harness when prompted, or pass `-a <agent>` (for example `-a codex`). All skills in `skills/` install together; `solve-issue` depends on the others.

### Claude Code plugin

In Claude Code:

```
/plugin marketplace add adib-11/issue-solver
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

## auto-solve service (in progress)

`service/` holds an unattended controller that works through open issues on your personal repositories. So far it scans and queues issues, checks that the chosen harness (Claude Code or Codex) is logged in, and runs the first two agent phases. Conventions discovers each repo's setup, check, and test commands and its commit style, and shows them on the Repos page, where you can override them. Brief turns the issue into an agent brief with testable acceptance criteria and the seams the tests will use, shown in job detail. An issue too vague for testable criteria becomes `needs_info` with the agent's questions; edit the issue and click Retry to brief it again. Other jobs then stop with "Pipeline ends here"; later phases are not built yet.

It needs Docker Engine 26 or later: each agent phase runs in a disposable container started through the host's Docker socket, which the controller mounts.

1. Create a GitHub App with Issues read, Contents write, Pull requests write, and Metadata read permissions. Download its private key. To have `needs_info` questions posted on the issue, give it Issues write instead and set `COMMENT_QUESTIONS=true` in `.env`.
2. Install the App on your personal account (not an organisation) and select the repositories it may work on. The controller rejects installations on any other account.
3. Copy `.env.example` to `.env` and fill it in. Put the private key at `./github-app.pem`, or set `GITHUB_APP_PRIVATE_KEY_PATH`. Set `DOCKER_GID` to the group that owns the Docker socket (`stat -c %g /var/run/docker.sock` on Linux; leave it at 0 on Docker Desktop).
4. Run `docker compose up --build`. The controller scans at startup and every 60 seconds.
5. Open `http://localhost:3000` and sign in as `admin` with `ADMIN_PASSWORD`.
6. Open Setup, choose a harness, and follow the login steps shown there, then click Test auth. The service only uses your subscription, never an API key.
   - Claude Code: run `claude setup-token`, put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, and restart.
   - Codex: log in once with your ChatGPT account through the runner image, with a device code:

     ```bash
     docker run --rm -it --mount type=volume,src=auto-solve-codex,dst=/codex -e CODEX_HOME=/codex auto-solve-runner:local codex login --device-auth -c 'cli_auth_credentials_store="file"' -c 'forced_login_method="chatgpt"'
     ```

     The login lives as `auth.json` on the `auto-solve-codex` volume, where Codex refreshes it in place. Don't copy it or use it anywhere else at the same time; the service runs one Codex session at a time.

Development: `cd service && bun install && bun test && bun run typecheck`.

Smoke test (opt-in, spends subscription quota, never run in CI): `cd service && CLAUDE_CODE_OAUTH_TOKEN=... bun scripts/smoke.ts <owner/repo> <issue number>` runs the real Claude Code CLI, and `CODEX_HOME=<dir with a ChatGPT-login auth.json> bun scripts/smoke.ts --codex <owner/repo> <issue number>` the real Codex CLI, through the conventions and brief phases on an issue of a throwaway repo of yours and prints both outputs. It uses the GitHub CLI (`gh`) to clone the repo and read the issue.
