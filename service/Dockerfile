FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.2
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29.8.0-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY --from=build /app/dist ./dist
ENV PATH=/app/node_modules/.bin:$PATH
RUN mkdir -p /data /workspaces && chown bun:bun /data /workspaces
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
