---
id: "253db2"
title: Parse human times in the user's time zone
status: done
priority: none
labels:
  - cli
  - m2
created_at: 2026-09-27T05:32:51.757Z
updated_at: 2026-09-28T02:41:33.136Z
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

## Outcome

Built as described in docs/design.md §11 (Standard flags, "As built").
- **Parser:** a strict grammar rather than chrono-node, which is forgiving by design and would guess.
- **Zone math:** native Temporal (Bun 1.4), so no polyfill or date-fns-tz.
- **Where it's resolved:** decided in favour of the backend. The CLI passes raw strings, and the backend resolves them in the user's zone. No command takes a time yet; mail and triggers will be the first callers.
- **Tests:** a table of inputs × zones (New York across its 8 March change, London across 29 March) with directions, plus rejections: skipped and repeated wall times, a bare hour, bad dates, contradictory `in … ago`, and unknown words.
