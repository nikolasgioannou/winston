---
id: "9c407f"
title: Define the event catalog and events table
status: done
priority: none
labels:
  - backend
  - events
  - m7
created_at: 2026-09-27T05:40:24.003Z
updated_at: 2026-10-01T18:29:31.893Z
blocked_by:
  - "480aff"
---

Event names and meanings are an invariant (docs/design.md Part 3 invariant 9). Many tickets depend on them, so they're defined once, as typed data in `packages/shared`, and everything else reads from that definition.

Build the catalog from §3's event tables:
- **Always delivered:** `user_message`, `telegram.reaction.added`, `task.completed`/`failed`/`needs_user`, `system.onboarding.completed`, `system.app.auth_expiring`/`auth_expired`.
- **Subscribable:**
  - `mail.message.received`/`sent`/`labels_changed`.
  - `calendar.invitation.received`, `calendar.event.created`/`updated`/`cancelled`, `calendar.rsvp.changed`, and the abstraction `calendar.event.starting`.
  - `system.app.connected`/`disconnected`, `system.settings.changed`.

For each event: its domain, a Zod payload schema, whether it's subscribable, which **filter fields** it supports (the same vocabulary as the CLI's domain flags, so `--from` means the same thing in `mail search` and in a subscription), whether it supports scoping (to a thread or event id), and a one-line description for `--help`.

Also:
- The `events` table (§14) with `dedupe_key` unique and a `self_caused` flag.
- `winston events catalog [<domain>]` (API + CLI), listing types, payload fields and filter flags, generated from the catalog so it can never drift.
- Envelope rendering for event items (the generic event shape with an escaped `<data>` block, §4), with snapshot tests.

Tests: every catalog entry has a valid schema and description, the CLI output snapshot, and the payload validation rejecting malformed events.

## As built

- The catalog lives in `@winston/domain/events` rather than `packages/shared`: `@winston/domain` (added since this ticket was written) holds the domain model, including the inbound payload schemas the catalog reuses.
- `events` table, `GET /v1/events/catalog`, `winston events catalog [<domain>]`. The CLI's test runs against the real route, so its snapshot is the catalog itself.
- Event envelopes already render generically (`renderEvent`: occurred_at, subscription note, escaped key-sorted `<data>`), with snapshot tests from M1; nothing to add.
- System events stay inbound items delivered to the front of house until 0512b5 wires them into subscriptions.

