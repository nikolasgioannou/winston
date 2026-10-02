---
id: "f6b5a6"
title: Keep Winston online through deploys
status: done
priority: high
labels:
  - infra
  - m8
  - vm
created_at: 2026-10-02T15:56:17.823Z
updated_at: 2026-10-02T18:35:05.161Z
blocked_by:
  - "eadb89"
---

Found in production on 2026-10-02: through every deploy Winston said "Your computer isn't reachable". The routing fix (vms.gateway_url, retries on 409) covers short commands while two gateways overlap. What still drops:

- **A command in flight when its gateway loses the VM socket** (the ALB cuts it at the end of the old task's drain) waits on the old gateway until that task is killed, then the agents' retry runs it again: commands from `attach`, `view-image` and the images job carry no id, so the VM can't tell it's a repeat. A long command also misses the retry window, which counts from the start of the call.
- **winstond's self-update** (right after every deploy) restarts it at once: systemd kills the commands it's running, and its memory (results kept for retries, the browser's windows, owners, site locks and handed-over windows) is lost mid-task.

Changes:

- **Gateway:** when a VM's socket closes, its in-flight commands fail at once with `409 vm_unavailable` instead of waiting, so the caller retries on whichever gateway the VM reconnects to. The VM keeps the result under the command's id, so nothing runs twice. `exec.fetch` on reconnect goes.
- **Agents client:** every exec gets an id (the caller's, or a fresh one), and the retry window counts from the first failure, not the start of the call (30 s, covering winstond's restart and a reconnect).
- **winstond:** applies an update's binaries at once but restarts only when idle: no command running and no browser window open (open windows close on their own when their runs end).
- Docs: design §15 (exec over a reconnect), §10 (updates), §19 (routing), the deploys runbook.

Tests: a socket closing fails its commands with `vm_unavailable`; a retry after a cut gets the first run's result; the client's id and window; winstond waiting for idle before restarting.

## As built

- `apps/gateway/src/execs.ts`: `closed(vmId)` fails a VM's in-flight commands with `VmUnavailableError` (409) when its socket closes; `reconnected` and its `exec.fetch` went. The `exec.fetch` frame stays for `GET /internal/vms/:userId/execs/:id`.
- `apps/agents/src/vm/gateway-client.ts`: execs get `newFrameId()` when the caller gives no id; `vmRetry.forMs` is 30 s, counted from the first failure.
- `apps/winstond`: `executor.busy()` (a running command or a kept result) and `browser.hasWindows()`; the daemon's update waits on `updates.idle()` (checked every 10 s) before `restart()`.
- Docs: design §10 (restart once idle), §15 (buffered results, retries by id), §19 (routing and the ALB rule's paths), the deploys runbook.
