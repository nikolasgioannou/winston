# The local OAuth relay for worktrees (scripts/oauth-relay.ts), run by
# docker-compose.yml. Development only; never deployed.
FROM oven/bun:1.4.2-distroless
WORKDIR /app
COPY scripts/oauth-relay.ts .
ENTRYPOINT ["bun", "oauth-relay.ts"]
