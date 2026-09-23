FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app

FROM base AS build
COPY . .
RUN test ! -e .env.local && test ! -e .git && test ! -e node_modules && test ! -e apps/web/node_modules
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun --bun run --filter @winston/web build
RUN bun run --filter @winston/server build

FROM base AS dependencies
COPY . .
RUN bun install --filter @winston/server --production --frozen-lockfile --ignore-scripts

FROM base AS runtime
COPY --from=dependencies /app/package.json ./package.json
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/adapters ./packages/adapters
COPY --from=dependencies /app/packages/contracts ./packages/contracts
COPY --from=dependencies /app/apps/server/package.json ./apps/server/package.json
COPY --from=dependencies /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 WEB_ASSET_DIRECTORY=/app/public
USER bun
EXPOSE 8080
CMD ["bun", "apps/server/dist/main.js"]
