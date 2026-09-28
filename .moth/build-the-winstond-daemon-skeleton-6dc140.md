---
id: "6dc140"
title: Build the winstond daemon skeleton
status: done
priority: none
labels:
  - m2
  - vm
created_at: 2026-09-27T05:32:51.365Z
updated_at: 2026-09-28T00:20:14.809Z
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

The image has no `winstond` systemd unit yet. Add it in this ticket, together with the binary: a placeholder unit without a binary would leave systemd `degraded`. Put the unit in the provisioning scripts (`image/scripts/`), as the other units will be.

The provider passes the registration token and gateway URL as the container environment variables `WINSTON_REGISTRATION_TOKEN` and `WINSTON_GATEWAY_URL` (docs/design.md §8a). They land in PID 1's (systemd's) environment, and `winstond` runs as a non-root user, so its unit needs `PassEnvironment=WINSTON_REGISTRATION_TOKEN WINSTON_GATEWAY_URL`. The EC2 path will use user data instead, so read both through one small config step.

## Outcome

Built as described in docs/design.md §15 ("winstond").
- **Binary:** `bun build --compile --target=bun-linux-arm64` produces an ~80 MB binary (mostly the Bun runtime). It runs on Ubuntu, with pino logging JSON as usual.
- **Target:** only arm64 today, for the local image. x64 comes with the AMI (M4).
- **Image:** `image/scripts/winstond.sh` installs the binary and the unit (`User=winstond`, `Restart=always`, `PassEnvironment=`).
- **Credentials:** the stored token first. A pre-open refusal switches to the other credential, because Bun's client can't see the 401. `hello` is sent only after the VM token is safely stored.
- **Frames:** `hello.cliVersion` is now nullable until the CLI exists.
- **Tests:** backoff, the token store (0600, atomic) and the daemon against a fake gateway (first boot, stored token, re-provisioned fallback, replaced connection).
- **Integration check:** a re-provisioned local VM registered and turned `ready` about 100 ms after start. `runuser -u winston -- cat /etc/winstond/token` is denied, and pings keep `last_seen_at` fresh.
- **Unit hardening:** deferred to the exec ticket, with the reasoning.
