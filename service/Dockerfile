# Built from the repository root: the controller reads the skill files at runtime.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY service/package.json service/bun.lock ./
RUN bun install --frozen-lockfile
COPY service/ .
RUN bun run build

FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29.8.0-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY service/package.json service/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY service/src ./src
# The skills are the single source of truth for the agent prompts; src/ reads them from ../../skills.
COPY skills /skills
COPY --from=build /app/dist ./dist
ENV PATH=/app/node_modules/.bin:$PATH
RUN mkdir -p /data /workspaces && chown bun:bun /data /workspaces
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
