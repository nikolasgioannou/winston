---
id: "253db2"
title: Parse human times in the user's time zone
status: todo
priority: none
labels:
  - cli
  - m2
created_at: 2026-09-27T05:32:51.757Z
updated_at: 2026-09-27T05:32:51.789Z
blocked_by:
  - "ae2a73"
---

Times appear everywhere in the CLI: `--since 3d`, `--until tomorrow`, `--at "fri 9am"`, `--expires "next monday"`, `--start "tomorrow 3pm"` (docs/design.md §11, Standard flags). They must resolve in the **user's** time zone, not the VM's or the server's. A user in New York saying "tomorrow 9am" means 9am New York time.

Research libraries: chrono-node for natural language, plus the Temporal API polyfill or date-fns-tz for zone math. Check Bun compatibility and correctness across DST transitions. Decide what's accepted:
- ISO-8601 with or without offset (without one means the user's zone).
- Relative durations (`2h`, `3d`, `30m`).
- Named days and times.

Ambiguous or unparseable input must fail with exit code 1 and a hint showing accepted forms, never silently guess.

Put this in `packages/shared`, so the backend can also resolve times consistently (triggers). The CLI gets the user's zone from `winston me get` or passes the raw string to the backend. Decide which, preferring resolution on the backend so there's one source of truth.

Tests: a table of inputs × zones (including America/New_York across a DST boundary, and Europe/London) → expected instants, plus rejection cases.
