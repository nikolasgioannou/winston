---
id: "5cbe5b"
title: Create the agents service worker loop
status: todo
priority: none
labels:
  - agents
  - backend
  - m1
created_at: 2026-09-27T05:30:54.234Z
updated_at: 2026-09-27T17:32:16.413Z
blocked_by:
  - "2c5ac8"
  - "9869b7"
---

`apps/agents` runs front-of-house turns and background-agent steps by pulling jobs from the queue (docs/design.md §9). This ticket builds the process shell, with no agent logic yet.

It should:
- Load config, create a logger and a DB pool.
- Run a worker loop with a registry of job handlers by `type`, leasing only types it has handlers for, with configurable concurrency.
- Pass each handler a context: job payload, logger with `jobId`, DB access, and a way to extend its lease.
- Handle SIGTERM gracefully: stop leasing, let in-flight handlers finish their current unit of work (for agent runs that will mean "finish the current step and checkpoint"), then exit. A second SIGTERM or a timeout forces exit. Leases make this safe either way.
- Expose a health indication for ECS later. Research how Fargate health checks work for a service without an HTTP port, and either add a tiny health endpoint or note the approach.

Add a trivial `noop` handler and a test that enqueues a job and sees the loop complete it. Test graceful shutdown by starting the loop, sending it a stop signal mid-job, and asserting the job completed and no new job was leased.
