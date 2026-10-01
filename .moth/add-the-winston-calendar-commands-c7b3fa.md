---
id: "c7b3fa"
title: Add the winston calendar commands
status: done
priority: none
labels:
  - cli
  - m5
created_at: 2026-09-27T05:37:39.456Z
updated_at: 2026-10-01T16:54:01.015Z
blocked_by:
  - "253db2"
  - "cfff20"
---

`winston calendar list|search|get|free|create|update|delete|rsvp`, following §11 exactly.

The list line format:
`evt_4Kd1  Tue 09-29 15:00–15:30 -04:00  Sync with Dana  [3 attendees, external, video]  personal`

`free` output should be easy for an agent to turn into a message for the user, for example grouped by day, with slots in the user's zone. `get` shows attendees with their RSVP state.

`--help` examples should cover the common assistant flows:
- What's on today and tomorrow.
- Find 30 minutes with Dana next week.
- Move this event to Thursday at 3, notifying attendees.
- Decline with a note.
- Create a recurring 1:1.

Tests: output snapshots, time parsing for `--start` in the user's zone, flag validation (needing exactly one of `--end`, `--duration` or `--all-day`), dry-run previews, and exit codes.

## As built

- `apps/cli/src/resources/calendar.ts`, tests in `calendar.test.ts`. The fake-backend harness moved to `apps/cli/src/testing.ts`, and the flag readers (`textFlag`, `listFlag`, `either`) to `flags.ts`, now that two resources share them.
- The API's event DTO gained `calendarName`, so list lines name a secondary calendar ("Family") rather than its id.
- Output tests assert exact text rather than snapshot files, like the mail tests. Time parsing for `--start` in the user's zone is tested where it happens, in the API's route tests (cfff20); the CLI sends times as typed.

