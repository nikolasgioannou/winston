---
id: "6bde95"
title: Execute shell commands on the VM over the websocket
status: done
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.429Z
updated_at: 2026-09-28T00:28:16.283Z
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

From the winstond ticket: `winstond` runs as the unprivileged `winstond` user, and commands must run as `winston` (docs/design.md §15). Decide how, for example a narrow sudoers rule (`winstond ALL=(winston) NOPASSWD: …`), `runuser` from a small privileged helper, or systemd transient units (`systemd-run --uid=winston`). Harden the winstond unit to match (`NoNewPrivileges` would rule out sudo).

## Outcome

Built as described in docs/design.md §15 (winstond: "Running commands as `winston`", "Exec", "Gateway side").
- **User switching:** a sudo rule limited to running as `winston`. It's the least-privileged of the options: `CAP_SETUID` and `systemd-run` via polkit both allow a path to root, and a setuid helper is custom privileged code.
- **Process group kill:** coreutils `timeout`. **Clean environment:** `env -i`.
- **Output:** each stream is capped at 1 MiB, and chunks stream on the arrival connection only. **Buffering:** results are kept for 5 minutes and fetched with `exec.fetch` after a reconnect.
- **Tests:** the executor's tests (streaming, order, exit codes, clean env and cwd, group kill, cap, fetch) use GNU `env -C` and `timeout`, so they run on Linux (CI) and skip on macOS. Locally they ran in `oven/bun:1.4.2` (5/5). Gateway tests cover the internal endpoint, `vm_unavailable`, bad requests, and fetch-after-reconnect.
- **End to end in the real VM:** runs as `winston`, the token is denied, the environment is clean, `winston` can't sudo, a timeout kills a background child, and output is capped.
- **Dev workflow:** putting the VM on a rebuilt image still takes manual steps. I noted it on the bun dev VM ticket (961613), including a state-machine decision to make with the user.
