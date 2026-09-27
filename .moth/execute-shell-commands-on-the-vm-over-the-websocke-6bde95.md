---
id: "6bde95"
title: Execute shell commands on the VM over the websocket
status: todo
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.429Z
updated_at: 2026-09-27T05:32:51.460Z
blocked_by:
  - "6dc140"
---

The `bash` tool runs commands on the user's VM through `gateway` → `winstond` (docs/design.md §15, `exec` frames).

In `winstond`:
- Handle `exec` frames: run the command with `bash -lc` as the **`winston` user** (not `winstond`), with the given `cwd` (default `/home/winston`) and env. The env carries `WINSTON_RUN_TOKEN` and must **not** leak `winstond`'s own environment.
- Stream stdout and stderr back in chunks (`exec.output`), then `exec.exit` with the code.
- Enforce `timeout_ms` by killing the whole process group.
- **Buffer each command's result by id for 5 minutes.** If the websocket drops mid-command, the gateway can fetch the result after reconnecting instead of re-running a possibly non-idempotent command.

In `gateway`: an internal endpoint `POST /internal/vms/:userId/exec` that sends the frame, collects the streamed output, and returns `{ stdout, stderr, exitCode, timedOut }`. If the VM isn't connected, return a clear error the agent can relay.

Research how to switch users from a daemon: `winstond` needs just enough privilege to spawn as `winston` (a `sudo` rule limited to that, a setuid helper, or systemd-run), without ever handing `winston` access to `/etc/winstond`. Pick the least-privileged approach and document why.

Tests: output streaming and ordering, exit codes, timeout killing children, user isolation (a command can't read the token), and result retrieval after a simulated reconnect.
