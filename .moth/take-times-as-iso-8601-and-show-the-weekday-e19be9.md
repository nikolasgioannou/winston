---
id: "e19be9"
title: Take times as ISO 8601 and show the weekday
status: backlog
priority: none
labels:
  - backend
  - cli
created_at: 2026-10-03T17:26:02.777Z
updated_at: 2026-10-03T17:26:02.777Z
---

From the production trace review (5c3cdf, 2026-10-03). Three kinds of friction showed up whenever Winston passed a time to the CLI:

- **A phrase it couldn't read.** `winston trigger create --at "tonight 9:40pm"` failed with "Couldn't understand the time". He retried with `2026-10-02T21:40`.
- **No visible way to give another place's time.** BA's itinerary gives London times (land 9:50, leave 11:15). He typed them as-is, they were read as New York times, and the layover landed five hours off before he fixed it. For the Cyprus fireside chat (17:40 Nicosia) he checked `--help`, found no way to give a zone, and converted to 10:40 New York by hand. That was correct, but it depended on him getting daylight saving right. ISO offsets (`2026-10-08T17:40+03:00`) already work; `--help` never says so.
- **A silent side effect.** `calendar update --start 18:30` on a 4–10 pm event kept its six-hour length and moved the end to 00:30. He noticed from the output and fixed it.

## Decision (with the founder, 2026-10-03)

Drop the natural-language time grammar. Winston knows the current moment and the user's offset from every envelope's `sent_at`. In the trace he wrote exact ISO times in almost every calendar command anyway. The real mistakes came from not being explicit about the time zone, which phrase parsing can't fix. Exact timestamps also make any mistake visible in the trace.

## Build

- **Time flags take ISO 8601** (`--start`, `--end`, `--at`, `--expires`, `--since`, `--until`, everywhere they appear: mail, calendar, tasks, triggers, history).
  - A date (`2026-10-08`) is the start of that day in the user's zone.
  - A date and time without an offset (`2026-10-08T15:00`) is in the user's zone.
  - With an offset (`2026-10-08T17:40+03:00`, or `Z`) it's that exact moment.
  - Keep `now` and plain durations (`30m`, `2h`, `3d`, `1w`), which resolve against now in the flag's direction (`--since 3d` looks back; `--expires 2h` looks ahead). They're trivial and unambiguous, and searches use them constantly.
  - Remove `today`, `tomorrow`, `yesterday`, weekdays (`fri`, `next mon`, `last friday`), clock words (`9am`, `noon`, `midnight`), the "in …"/"… ago" forms, and either-order combinations.
  - An unreadable time is an error that shows the accepted forms with one example of each (exit 1).
  - Keep the existing safety: a time the clocks skip or repeat is rejected with a hint to add an offset.
- **Show the weekday wherever an envelope gives a time** (`sent_at`, `occurred_at`, a task's `started_at`, a trigger's fire time), e.g. `<sent_at>2026-10-02T18:12:44-04:00 (Friday)</sent_at>`. The ISO part stays machine-readable. Working out a weekday from a bare date is the date maths models most often slip on; with it shown, "this Thursday" is easy. Rendering stays deterministic, so caching is unaffected (`packages/shared/src/time.ts` `formatInTimeZone`, used by `packages/domain/src/envelope.ts`).
- **`--help` and examples:**
  - every time flag's description says "ISO 8601, in the user's zone; add an offset for a time somewhere else, e.g. 2026-10-08T17:40+03:00";
  - examples that use phrases (`"thu 3pm"`, `"fri 2:45pm"`, `"next fri 9am"`, `--since today --until "tomorrow 11:59pm"` in `apps/cli/src/resources/calendar.ts`, `trigger.ts` and others) are rewritten in ISO.
- **Prompts:** the front of house's line "Times you pass (`--start "thu 3pm"`, `--since mon`) are read in the user's time zone" (`packages/prompts/src/front-of-house.md`) becomes the ISO rule plus the offset for other places. Check the background prompt for the same.
- **`calendar free` never offers the past:** the start of its range is never earlier than now. `--since 2026-10-02` today currently returns slots from midnight.
- **`calendar update` says when it kept the length:** when `--start` moves without `--end` or `--duration`, the output adds "kept its 6h length; pass --end to change it".

Callers of `parseHumanTime`: `packages/vm-api/src/mail.ts`, `calendar.ts`, `calendar-write.ts`, `tasks.ts`, `triggers.ts`, `history.ts`, and `TimeParseError` in `connections.ts`.

Docs: §11 (the `--since`/`--until` convention and the human-time "As built"), the envelope examples in §4, and a decision-log entry recording that the grammar was dropped and why.

Tests: each accepted form (date, date-time, offset, `Z`, `now`, durations in both directions); removed phrases rejected with the helpful error; skipped and repeated DST times rejected; the weekday in envelopes; `calendar free` clamped to now; the kept-length notice; CLI help examples parse.
