---
id: "c7b3fa"
title: Add the winston calendar commands
status: todo
priority: none
labels:
  - cli
  - m5
created_at: 2026-09-27T05:37:39.456Z
updated_at: 2026-09-27T05:37:39.508Z
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
