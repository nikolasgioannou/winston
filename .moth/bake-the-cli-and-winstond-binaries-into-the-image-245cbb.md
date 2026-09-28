---
id: "245cbb"
title: Bake the CLI and winstond binaries into the image
status: done
priority: none
labels:
  - m2
  - tooling
  - vm
created_at: 2026-09-27T05:32:51.804Z
updated_at: 2026-09-28T02:45:40.386Z
blocked_by:
  - "2dd479"
  - "6dc140"
  - "ae2a73"
---

The image ships with the current `winston` and `winstond` binaries. After that, `winstond` self-updates them (M4). This ticket makes `image:build:local` compile both for linux-x64 first, and install them:
- `/usr/local/bin/winston`, executable by the `winston` user.
- `/usr/local/lib/winstond/winstond`, owned by `winstond`.

Record their versions somewhere `winstond` can report in `hello`, for example an embedded build constant.

Decide on versioning: git SHA vs a monotonic build number vs semver. Since every commit to `main` deploys, the git SHA plus build time is probably right, but the self-update ticket needs to compare versions, so make sure "which is newer" is answerable.

Check the `winston` binary's startup time. It runs on almost every agent step, so it should feel instant. If it's slow, investigate before moving on.

Done when a freshly built local image, booted through the `VmProvider`, has `winston me get` working from `bash` inside it end to end.

## Outcome

Built as described in docs/design.md §18 ("Built so far": `winstond.sh` and `cli.sh`, Versions, CLI speed).
- **Target:** linux-arm64, not linux-x64, because the local image is arm64 (decided in the systemd spike). x64 comes with the AMI.
- **Versioning:** `0.1.<commit count>+<sha>[.dirty]`, embedded with `--define`. The commit count makes "which is newer" a number comparison for the self-update ticket.
- **`hello`:** `winstond` reports both versions, the CLI's by running `winston --version` at startup.
- **Done check:** a freshly built image booted through the `VmProvider`, then `winston me get` from `bash` worked end to end, the VM reported both versions, and ownership is as specified. Startup is about 5 ms, and the full round trip about 8 ms.
