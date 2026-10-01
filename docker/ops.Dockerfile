# Production operations (packages/db/src/ops.ts): migrations, the allowlist
# and read-only SQL, run as one-off ECS tasks by `bun run prod`. Build from
# the repo root:
#   docker build -f docker/ops.Dockerfile .
FROM oven/bun:1.4.2-slim AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --filter @winston/db
RUN bun build packages/db/src/ops.ts \
    --target bun --production --keep-names --sourcemap=linked --outdir /out

FROM oven/bun:1.4.2-distroless
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /repo/packages/db/migrations /app/migrations
ENV NODE_ENV=production MIGRATIONS_DIR=/app/migrations
USER nonroot
ENTRYPOINT ["bun", "/app/ops.js"]
