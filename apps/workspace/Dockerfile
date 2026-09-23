FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /app
COPY . .
RUN test ! -e .env.local && test ! -e .git && test ! -e node_modules
RUN bun install --filter @winston/workspace --frozen-lockfile --ignore-scripts
RUN bun run --filter @winston/workspace build

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends util-linux procps ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(id -u bun)" = 1000 \
    && test "$(id -g bun)" = 1000
WORKDIR /app
COPY --from=build /app/apps/workspace/dist/ ./
COPY apps/workspace/entrypoint.sh /usr/local/bin/workspace-entrypoint
RUN chown -R root:root /app /usr/local/bin/workspace-entrypoint \
    && chmod 0755 /app \
    && chmod 0444 /app/*.js \
    && chmod 0555 /usr/local/bin/workspace-entrypoint \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/workspace-entrypoint"]
