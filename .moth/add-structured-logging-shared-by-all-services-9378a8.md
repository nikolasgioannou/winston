---
id: "9378a8"
title: Add structured logging shared by all services
status: done
priority: none
labels:
  - backend
  - m1
  - tooling
created_at: 2026-09-27T05:28:45.436Z
updated_at: 2026-09-27T18:49:05.590Z
blocked_by:
  - "2c5ac8"
---

All long-running services and `winstond` need logs that are readable locally and parseable in CloudWatch. There's no observability tooling beyond logs and the database (docs/design.md §12). Placed directly before the job queue, its first consumer.

Research: pino vs consola vs a custom logger under Bun. Outcome: **pino**, without its worker-thread transports. Those are known to keep Bun processes alive and to fail module resolution under Bun. Pretty output uses `pino-pretty` as a synchronous stream instead.

`createLogger(service, { level, pretty, destination })` in `@winston/shared/logger`:
- JSON lines when stdout isn't a terminal, pretty output when it is. No environment setting needed.
- Context through child loggers (`userId`, `runId`, `jobId`, `vmId`, …).
- Sensitive keys (`authorization`, `cookie`, `password`, `secret`, `token`, `ciphertext`) redacted at the top level and one level down.
- The level is passed in by each service from its own config (added with the first service).

Tests:
- JSON lines are tagged with the service.
- Child context appears on every line, including nested children.
- Redaction applies at both depths, and secrets never appear in the output.
- The level is respected.

Also checked: a script using the logger exits on its own in both modes.
