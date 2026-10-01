# The site (docs/design.md §9): the TanStack Start build behind
# apps/web/scripts/serve.ts, bundled into one file, run on Bun's distroless
# image. Build from the repo root:
#   docker build -f docker/web.Dockerfile .
FROM oven/bun:1.4.2-slim AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --filter @winston/web
WORKDIR /repo/apps/web
RUN bun --bun vite build
RUN bun build scripts/serve.ts \
    --target bun --production --sourcemap=linked --outdir /out

FROM oven/bun:1.4.2-distroless
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /repo/apps/web/dist/client /app/client
ENV NODE_ENV=production WEB_CLIENT_DIR=/app/client
USER nonroot
ENTRYPOINT ["bun", "/app/serve.js"]
