---
id: "9378a8"
title: Add structured logging shared by all services
status: todo
priority: none
labels:
  - backend
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.436Z
updated_at: 2026-09-27T05:28:45.465Z
blocked_by:
  - "29521a"
---

Four long-running services (`api`, `agents`, `gateway`, `web`) plus `winstond` all need logs that are readable locally and parseable in CloudWatch in production. There's no observability tooling beyond logs and the database (docs/design.md §12), so good structured logs matter.

Research the options for Bun specifically: pino (and whether its worker-thread transports behave under Bun), consola, or a thin custom JSON logger. Compare them on Bun compatibility, performance, child loggers with bound context, and pretty-printing in dev. Pick one and note why in the ticket's commit or a short comment.

Provide in `packages/shared`:
- `createLogger(service)`, producing JSON lines in production and pretty output locally, with the level from config.
- Child loggers carrying context (`userId`, `runId`, `jobId`, `vmId`), so a whole agent run can be followed by grepping one id.
- Redaction for obviously sensitive keys (tokens, authorization headers, ciphertext).

Add a test that redaction works and that context propagates to child loggers.
