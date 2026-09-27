---
id: "6dc140"
title: Build the winstond daemon skeleton
status: todo
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.365Z
updated_at: 2026-09-27T05:32:51.414Z
blocked_by:
  - "4e6f9b"
  - "ea07c8"
---

`winstond` is the VM's lifeline: the only process on the VM that holds a credential, and the only one talking to the backend (docs/design.md §10, §15).

Build `apps/winstond` as a Bun program compiled to a single binary with `bun build --compile`. Research compile targets (linux-x64 for the image), binary size, and how compiled Bun binaries read env and files.

Behaviour:
- **First boot:** read the registration token and gateway URL from the environment (Docker) or instance user data (EC2, later), register, and write the returned VM token to `/etc/winstond/token` (owned by `winstond`, mode 0600). On later boots, use the stored token.
- **Connection:** a websocket client with exponential backoff reconnect (1 s → 30 s, with jitter), `hello` with its version and the CLI version on connect, ping every 20 s.
- **Supervision:** a systemd unit with `Restart=always`, running as the `winstond` user. Install it in the image scripts.

The token must never be readable by the `winston` user. Verify that inside the container (`sudo -u winston cat /etc/winstond/token` fails).

Tests: the backoff schedule, token persistence logic, and handling a replaced connection, with a fake gateway. Integration check: boot the local image with `winstond` baked in, and watch it register and turn `ready`.
