# api, agents and gateway (docs/design.md §9): each bundled into one file,
# run on Bun's distroless image. Build from the repo root:
#   docker build -f docker/service.Dockerfile --build-arg SERVICE=api .
FROM oven/bun:1.4.2-slim AS build
ARG SERVICE
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile --filter "@winston/${SERVICE}"
RUN bun build "apps/${SERVICE}/src/main.ts" \
    --target bun --production --sourcemap=linked --outdir /out

# No shell, no package manager; just Bun and the bundle.
FROM oven/bun:1.4.2-distroless
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production
USER nonroot
# Bun is PID 1 and gets SIGTERM directly; each service handles it.
ENTRYPOINT ["bun", "/app/main.js"]
