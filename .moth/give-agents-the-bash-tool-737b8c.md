---
id: "737b8c"
title: Give agents the bash tool
status: todo
priority: none
labels:
  - agents
  - m2
created_at: 2026-09-27T05:32:51.521Z
updated_at: 2026-09-27T05:32:51.569Z
blocked_by:
  - "6bde95"
  - "cb9674"
---

`bash` is the main native tool (docs/design.md §5). Almost every capability runs through it, via the `winston` CLI.

Implement it in `apps/agents`:
- Before each execution, mint a **run token**: a short-lived signed token containing run id, user id and run kind, signed with a backend secret. Pass it as `WINSTON_RUN_TOKEN` in the command's environment. It's only accepted over that VM's websocket (the VM API ticket enforces that), so it's useless if exfiltrated.
- **Timeouts:** ~10 s for the front of house (it must stay responsive, and anything longer should be delegated), and a much longer default for background runs.
- **Output handling:** truncate what goes back into the model's context to about 4k tokens. Save the full output to a file on the VM (for example `~/.winston/outputs/<run>/<step>.txt`) and tell the model the path, so it can read more with `sed`/`rg` if needed (§2 compaction hygiene).
- **Errors the model can act on:** "the computer is unreachable right now", a timeout with partial output, and non-zero exit codes shown plainly.

Register the tool for front-of-house turns. Background runs pick it up in M6.

Tests with a fake gateway: the token is present in the env and verifiable, truncation and the saved-output path, the different timeouts per run kind, and the unreachable-VM message.
