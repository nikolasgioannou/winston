FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS build
WORKDIR /app
COPY . .
RUN test ! -e .env.local && test ! -e .git && test ! -e node_modules
RUN bun install --filter @winston/browser --frozen-lockfile --ignore-scripts
RUN bun run --filter @winston/browser build
RUN mkdir /runtime-deps && cp -R -L apps/browser/node_modules/playwright-core /runtime-deps/playwright-core

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS browser-runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb util-linux ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(id -u bun)" = 1000 && test "$(id -g bun)" = 1000
WORKDIR /app
COPY --from=build /app/apps/browser/dist/ ./
COPY --from=build /runtime-deps/ /app/node_modules/
COPY apps/browser/entrypoint.sh /usr/local/bin/browser-entrypoint
COPY apps/browser/chromium.sh /usr/local/bin/browser-chromium
RUN chown -R root:root /app /usr/local/bin/browser-entrypoint /usr/local/bin/browser-chromium \
    && chmod 0555 /usr/local/bin/browser-entrypoint /usr/local/bin/browser-chromium \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +
ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/browser-entrypoint"]

FROM build AS validation-build
RUN bun build apps/browser/tests/runtime/fixture.ts --target=bun --env=disable --external playwright-core --outfile=/fixture.js

FROM browser-runtime AS validation
COPY --from=validation-build /fixture.js /app/main.js

FROM browser-runtime AS runtime
