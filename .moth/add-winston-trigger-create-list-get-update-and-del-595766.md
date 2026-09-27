---
id: "595766"
title: Add winston trigger create, list, get, update and delete
status: todo
priority: none
labels:
  - cli
  - events
  - m7
created_at: 2026-09-27T05:40:24.109Z
updated_at: 2026-09-27T05:40:24.164Z
blocked_by:
  - "253db2"
  - "88f5ee"
---

Winston manages his own triggers through the CLI. Users never see them (docs/design.md §3, §11 `winston trigger`).

`trigger create` takes exactly one of `--at <time>`, `--cron "<expr>"` or `--on <event-type>`, plus a required `--note`. Optional flags:
- **The domain filter flags** for subscriptions (`--from`, `--unread`, `--attendee`, `--external` …). They're validated against that event type's allowed filter fields from the catalog, and they're the *same* flags as `search`.
- `--native "<query>"`, `--scope <id>` (validated: a `thr_` for mail events, an `evt_` for calendar events), `--lead <duration>` (only for `calendar.event.starting`), `--account`.
- `--max-fires`, `--expires <time>`, `--on-expire <text>`.

Validation must be strict, with helpful errors, because a silently wrong trigger is a silent failure of proactivity. Examples: "`--lead` only applies to calendar.event.starting", and "`--unread` isn't a filter for calendar events; see `winston events catalog calendar`".

Also:
- `list` (active by default, `--all`), `get`, `update` (any create flag) and `delete`.
- Output shows `next_fire_at` for schedules, and fire counts and expiry for everything.
- Register `trg_` with the `winston get` resolver.

`--help` examples: a one-off reminder, a weekday cron, a filtered mail subscription, a meeting heads-up with `--lead`, and the full "tell me when Dana replies, or nudge me Friday" example from §11.

Tests: validation of each rule, time parsing in the user's zone, `next_fire_at` shown correctly, and snapshots of list and get output.
