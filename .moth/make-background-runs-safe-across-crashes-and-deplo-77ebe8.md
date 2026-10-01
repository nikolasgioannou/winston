---
id: "77ebe8"
title: Make background runs safe across crashes and deploys
status: done
priority: none
labels:
  - agents
  - backend
  - m6
created_at: 2026-09-27T05:38:50.215Z
updated_at: 2026-10-01T18:23:36.534Z
blocked_by:
  - "64a47f"
  - "d66d10"
---

Deploys happen on every push, so runs will regularly be interrupted mid-step (docs/design.md §8b, Deploys never lose agent work). Checkpointing handles most of it, but there's one real hazard: **a tool that executed but whose step wasn't checkpointed yet gets executed again on resume.** For a `bash` command that ran `winston mail send`, that means a duplicate email.

Close the gap:
- **Idempotency keys for writes:** each `bash` execution gets a `WINSTON_TOOL_CALL_ID` (run id + step + tool call id) alongside the run token. The CLI sends it with every write. The VM API dedupes writes by that key using the audit log: if the same key already produced an outcome, return the recorded result instead of acting again. Apply this in the connector framework, so every current and future write is covered.
- **Exec result buffering:** `winstond` already buffers results for 5 minutes. On resume, if the last step's tool call has a buffered result, use it instead of re-running.
- **Graceful shutdown:** on SIGTERM, a running step finishes and checkpoints before the worker exits. The worker loop already supports this, so verify it for background runs specifically.

Tests:
- Simulate a crash after a write but before the checkpoint, then resume. Exactly one email is sent, via mocked Gmail.
- The buffered exec result is reused.
- Graceful shutdown completes the in-flight step.

## As built

Re-checked against the engine (64a47f): it stores the model's tool requests before running them and never re-runs a request after a crash, so "a tool that executed gets executed again on resume" can't happen. What was left was turning "unknown" into the real result, and deploys:

- **Exec ids instead of write keys:** `bash` gives each command an exec id derived from the run and tool call; the gateway joins a repeated id in flight and `winstond` never runs a seen id twice. On resume, an interrupted `bash` call fetches its result from the VM by that id (new `GET /internal/vms/:userId/execs/:execId`), and only falls back to "unknown" when the VM no longer has it. Audit-log write keys would guard against the same call running twice, which can no longer happen, so they weren't built (docs/design.md §9, "Crash safety").
- `view_image` is simply re-run on resume (read-only); a handoff that died before parking parks.
- **Shutdown:** a test stops the worker mid-step and sees the step finish and checkpoint. The agents task now gets Fargate's 120-second stop timeout with `SHUTDOWN_TIMEOUT_MS` at 110 s.
- Fixed while here: saved long outputs were named by a per-tool counter that restarts each background step, so they overwrote each other; they're named by tool call now.

