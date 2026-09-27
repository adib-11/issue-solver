# The disposable container each agent phase runs in. It carries the harness CLIs and no configuration of
# their own, so the target repo's CLAUDE.md or AGENTS.md loads normally.
FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/harness
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
ENV PATH=/opt/harness/node_modules/.bin:$PATH
USER bun
WORKDIR /work
