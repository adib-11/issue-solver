# issue-solver

`issue-solver` provides two complementary ways to turn GitHub issues into clean, test-first pull requests with automated code reviews:

1. **The manual `solve-issue` skill bundle**: An interactive, user-invoked Agent Skills workflow that guides you from issue selection to an opened PR inside your agent harness (Claude Code, Codex, Cursor). Works on any repository (personal, forks, or external open-source projects).
2. **The automated `auto-solve` service**: An unattended, self-hosted service that continuously watches your personal GitHub repositories, picks up open issues, and runs the entire quality pipeline in isolated Docker containers, publishing one draft PR per issue.

Both surfaces live in this repository and share the exact same prompt definitions and engineering standards from [`skills/`](skills/) as their single source of truth.

---

## 1. Manual `solve-issue` Skill Bundle

The `solve-issue` skill bundle walks you interactively from "I want to fix something" to an opened pull request: pick an issue from a shortlisted backlog, draft a testable brief, implement it test-first at agreed seams, review it across Standards and Spec axes, and push after your explicit confirmation.

Requires the [`gh` CLI](https://cli.github.com) logged in (`gh auth login`), plus `git` and `bash`.

### Install

#### skills.sh (Codex, Claude Code, Cursor, and other Agent Skills harnesses)

```bash
npx skills add adib-11/issue-solver
```

Pick your harness when prompted, or pass `-a <agent>` (for example `-a codex`). All skills in `skills/` install together; `solve-issue` depends on the others.

#### Claude Code plugin

In Claude Code:

```
/plugin marketplace add adib-11/issue-solver
/plugin install solve-issue@issue-solver
```

For a local checkout, start Claude Code with `claude --plugin-dir /path/to/issue-solver`.

#### Manual

Copy every directory under `skills/` into your harness's skills directory (for example `~/.codex/skills/` or `~/.claude/skills/`).

### Run

- **Claude Code:** `/solve-issue` (or as a plugin: `/solve-issue:solve-issue`)
- **Codex:** `$solve-issue`, or select it from `/skills`
- **Other harnesses:** invoke the `solve-issue` skill following the harness's conventions for user-invoked skills

### Harness metadata

- `SKILL.md` frontmatter `disable-model-invocation: true` prevents harnesses from invoking `solve-issue` and `implement` autonomously.
- `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` for the same skills in Codex.
- `bash scripts/check-skills.sh` verifies that every skill conforms to these requirements and contains no harness-specific tool names.

---

## 2. How the Service Relates to the Manual Skill Bundle

| Aspect | Manual `solve-issue` Skill Bundle | Automated `auto-solve` Service |
|---|---|---|
| **Invocation** | Interactive, user-invoked in agent terminal/chat | Unattended background service (polling or webhooks) |
| **Repository Scope** | Any repo (personal, forks, external open-source) | Personal GitHub account repos only (orgs and forks rejected) |
| **Human Gates** | Human picks issue, approves brief/seams, confirms push | Human only reviews the final draft PR on GitHub (or clicks Retry / Run anyway in dashboard) |
| **Execution Environment** | Host machine / local harness workspace | Disposable Docker runner containers (no credentials, dropped caps) |
| **Source of Truth** | [`skills/`](skills/) markdown files | Reads and inlines the exact same [`skills/`](skills/) files into agent prompts |

Both surfaces enforce the exact same engineering discipline: test-first development with red/green proof, repository-discovered conventions, and two-axis code reviews (Standards and Spec).

---

## 3. The `auto-solve` Service

`service/` contains an unattended background controller and dashboard that works through open issues on your personal GitHub repositories.

### What it does

1. **Intake**: Discovers open issues on your enabled repositories via polling (every 60s) or webhooks. Filters out assigned issues, issues already addressed by open PRs, forks, and archived repositories. Untrusted authors (issues opened by non-collaborators) are marked `skipped: untrusted author` and require clicking **Run anyway** in the dashboard.
2. **Conventions**: Runs an agent phase to discover each repo's setup command, check commands, single-test-file command template, commit style, and whether tests exist. Conventions are cached and can be overridden via the dashboard Repos page.
3. **Brief**: Turns the issue into a structured brief with independently checkable acceptance criteria and agreed test seams. If an issue is too vague, it becomes `needs_info` with open questions (optionally posted as an issue comment).
4. **Implement**: Implements the fix test-first in an isolated container. The agent only edits files; the controller validates the diff (rejecting empty diffs, workflow edits, or missing tests when tests exist) and creates commits in the repository's commit style.
5. **Red/Green Proof & Checks**: Verifies that each new test fails on the base code and passes on the change. Then runs the repository's setup and check commands in a clean container with zero credentials.
6. **Review Loop**: Reviews the change in two parallel sessions: **Standards** (repository guidelines + code smell baseline) and **Spec** (the brief + issue snapshot). A fix phase decides each finding (fixed, or rejected with a mandatory reason), commits fixes, and re-runs checks (up to 3 rounds).
7. **Publish Draft PR**: Pushes the commits to `agent/issue-<number>` and opens a single draft pull request with a complete summary, acceptance criteria checklist, seams tested, check results, and review decisions. Reuses existing PRs if present; never force-pushes, writes to default branches, or auto-merges.

### Security and Sandbox Model

- **Controller**: Holds the GitHub App private key and host Docker socket. It never executes arbitrary repository code directly on the host.
- **Runners**: Each agent phase runs in a disposable, nonroot container limited to 2 CPUs, 4 GiB RAM, 256 PIDs, with dropped capabilities and `no-new-privileges`. Runners mount only the workspace volume and the active harness credentials; they never receive GitHub tokens or the Docker socket.
- **Checks Sandbox**: Repository build, setup, and check commands run in a fresh container with no network, no credentials, and no harness access.

---

## 4. Setup and Quick Start

You can go from zero to a running service using only this guide.

### Prerequisites

- [Docker Engine 26+](https://docs.docker.com/engine/install/) with Docker Compose v2.
- A personal GitHub account.
- An active Claude (Pro/Team) or ChatGPT (Plus/Team/Pro) subscription.

### Step 1: Create a GitHub App

1. In your browser, navigate to [GitHub Developer Settings > GitHub Apps > New GitHub App](https://github.com/settings/apps/new).
2. Configure the general settings:
   - **GitHub App name**: A unique name (e.g. `auto-solve-<your-username>`).
   - **Homepage URL**: Your GitHub profile URL or repository URL.
   - **Webhook**:
     - If using default polling: leave **Active** unchecked.
     - If using webhooks: check **Active**, set **Webhook URL** to `https://<your-public-domain>/api/webhook`, and set a strong **Webhook secret** (to be used as `WEBHOOK_SECRET` in `.env`).
3. Set **Repository permissions**:
   - **Issues**: `Read-only` (or `Read and write` if you want the service to post `needs_info` questions as issue comments when `COMMENT_QUESTIONS=true`).
   - **Contents**: `Read and write` (required to clone code and push feature branches).
   - **Pull requests**: `Read and write` (required to open draft pull requests).
   - **Metadata**: `Read-only` (selected automatically by GitHub).
4. Subscribe to events (only if using webhooks):
   - Check **Issues** under event subscriptions.
5. Under **Where can this GitHub App be installed?**, select **Only on this account**.
6. Click **Create GitHub App**.
7. On the App settings page:
   - Note the numeric **App ID** (you will set this as `GITHUB_APP_ID`).
   - Under **Private keys**, click **Generate a private key**. Save the downloaded `.pem` file as `./github-app.pem` in the root of your local clone.

### Step 2: Install the GitHub App

1. From the GitHub App's settings sidebar, click **Install App**.
2. Click **Install** next to your **personal account**.
   > [!IMPORTANT]
   > The App must be installed on your personal user account. The service explicitly rejects installations on organizations.
3. Choose repository access: select **All repositories** or choose specific repositories you want `auto-solve` to process.

### Step 3: Configure `.env`

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```dotenv
# Required: Your personal GitHub username
OWNER_LOGIN=octocat

# Required: GitHub App ID from the App settings page
GITHUB_APP_ID=123456

# Optional: Path to downloaded private key (defaults to ./github-app.pem)
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.pem

# Required: Admin password for the web dashboard
ADMIN_PASSWORD=change-me-to-a-secure-password

# Optional: Host port for dashboard (defaults to 3000)
PORT=3000

# See .env.example for all optional settings (webhooks, issue comments, etc.)
```

### Step 4: Build and Start

All dependency versions in `service/package.json` and container base images (`oven/bun:1.4.2`, `docker:29.8.0-cli`) are pinned, and the lockfile (`service/bun.lock`) is committed.

Start the service with:

```bash
docker compose up --build
```

(Add `-d` to run in the background: `docker compose up --build -d` and view logs with `docker compose logs -f controller`).

Open `http://localhost:3000` in your browser and log in as `admin` with your `ADMIN_PASSWORD`.

---

## 5. Harness Authentication (Subscription Only)

The service runs agents strictly using your personal subscriptions and never uses metered API keys. Choose either **Claude Code** or **Codex** on the dashboard Setup page (`http://localhost:3000/setup`).

### Option A: Claude Code

1. Install Claude Code on any computer with a browser and run:
   ```bash
   claude setup-token
   ```
2. Sign in with the Claude account with an active subscription and copy the printed token.
3. In your `.env` file, set:
   ```dotenv
   CLAUDE_CODE_OAUTH_TOKEN=your-token-here
   ```
4. Restart the service:
   ```bash
   docker compose up -d
   ```
5. On the dashboard **Setup** page, select **Claude Code** and click **Test auth**.

The token is valid for one year. The setup page displays its age so you can renew it prior to expiry.

### Option B: OpenAI Codex

Codex authenticates via a one-time device code with your ChatGPT subscription following OpenAI's CI/CD guidance:

1. Ensure the containers and volumes have been created by running `docker compose up -d` at least once.
2. Run the login command on your host machine:
   ```bash
   docker run --rm -it \
     --mount type=volume,src=auto-solve-codex,dst=/codex \
     -e CODEX_HOME=/codex \
     auto-solve-runner:local \
     codex login --device-auth \
     -c 'cli_auth_credentials_store="file"' \
     -c 'forced_login_method="chatgpt"'
   ```
3. Open the URL printed in your terminal, sign in with your ChatGPT subscription account, and enter the code.
4. The credentials are saved to `auth.json` (mode 0600) on the `auto-solve-codex` Docker volume and refreshed in place automatically.
5. On the dashboard **Setup** page, select **Codex** and click **Test auth**.

---

## 6. Transport: Polling vs Webhook

The service supports two intake transports:

### Polling (Default, Localhost)

- **How it works**: The controller polls GitHub every 60 seconds (and once on startup) for open issues on all enabled repositories.
- **Best for**: Local workstations, development environments, and home servers behind NAT/firewalls.
- **Setup**: Requires no public IP, no domain name, no SSL certificates, and no webhook secrets. Simply leave `PUBLIC_URL` and `WEBHOOK_SECRET` blank in `.env`.

### Webhook Transport (Immediate Intake, Public HTTPS)

- **How it works**: New issues trigger an immediate webhook delivery from GitHub, starting the pipeline within seconds. Polling continues in parallel every 60 seconds as a fallback to ensure missed deliveries are recovered.
- **Best for**: Dedicated cloud servers, VPS hosting, or tunnels (e.g. Cloudflare Tunnel, ngrok) with a public HTTPS URL.
- **Setup**:
  1. Set `PUBLIC_URL=https://your-domain.example.com` and `WEBHOOK_SECRET=your-secret` in `.env`.
  2. In your GitHub App settings:
     - Activate the Webhook.
     - Set **Webhook URL** to `https://your-domain.example.com/api/webhook` (or `/webhook`).
     - Set **Webhook secret** to match `WEBHOOK_SECRET`.
     - Subscribe to the **Issues** event (`issues: opened`).
  3. Restart the controller (`docker compose up -d`).

The webhook endpoint verifies HMAC-SHA256 signatures in constant time, caps payloads at 1 MiB, filters out duplicate delivery GUIDs and non-candidate issues, and commits the delivery and job atomically before replying with HTTP 202 in under 10 seconds.

---

## 7. Running the Smoke Script (`smoke.ts`)

`service/scripts/smoke.ts` is an opt-in integration smoke test that executes the real Claude Code or Codex CLI through the conventions, brief, and implement phases on an actual issue in a throwaway personal repository.

> [!WARNING]
> The smoke script uses your real subscription credentials and consumes actual quota. It is never run in CI.

### Prerequisites

- The [GitHub CLI (`gh`)](https://cli.github.com) installed and authenticated on your machine (`gh auth login`).
- A throwaway personal repository with an open issue.

### Usage

Run with **Claude Code**:

```bash
cd service
CLAUDE_CODE_OAUTH_TOKEN=your-token bun scripts/smoke.ts <owner/repo> <issue-number>
```

Run with **Codex**:

```bash
cd service
CODEX_HOME=/path/to/dir-with-auth.json bun scripts/smoke.ts --codex <owner/repo> <issue-number>
```

### What it does

1. Clones `<owner/repo>` into a temporary directory with Git hooks disabled.
2. Fetches the issue snapshot via `gh issue view`.
3. Runs the **conventions** phase to extract project commands and commit conventions.
4. Runs the **brief** phase to generate acceptance criteria and test seams (exits cleanly if `needs_info`).
5. Runs the **implement** phase test-first, validating that tests were added and that the checkout was not corrupted.
6. Commits the change in the temporary checkout and prints the commit metadata. The temporary checkout is cleaned up and changes are **never pushed** to GitHub.

---

## 8. Development and Testing

To develop and test the service locally without Docker:

```bash
cd service

# Install pinned dependencies
bun install --frozen-lockfile

# Run the 200+ unit and integration test suite
bun test

# Run static typecheck and security checks (enforces no raw HTML insertion)
bun run typecheck
```

To run repository-level skill checks:

```bash
# Verify skill metadata and harness-neutral wording
bash scripts/check-skills.sh

# Test skill candidate filtering and workspace scripts
bash scripts/test-candidates.sh
bash scripts/test-workspace.sh
```
