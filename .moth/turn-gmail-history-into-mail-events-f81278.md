---
id: "f81278"
title: Turn Gmail history into mail events
status: done
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.445Z
updated_at: 2026-10-01T19:12:43.607Z
blocked_by:
  - "6af84b"
  - "70194e"
---

The `sync_connection` handler for mail: fetch everything since the stored `historyId` and turn it into catalog events (docs/design.md §3, §17 Event pipeline steps 2–4).

Research `history.list` carefully: history types (`messageAdded`, `labelAdded`, `labelRemoved`), pagination, the fact that history ids can expire (then you get a 404 and must fall back to a bounded resync, for example recent messages in the last N days, and reset the checkpoint), and batching message fetches for the payload fields.

Produce:
- **`mail.message.received`:** new inbox messages not sent by the user. The payload has ids, from, to/cc, subject, snippet, labels, category and has-attachments, plus **`is_reply_to_user`**: true when the thread's previous message was sent by the user. That's what "tell me when someone finally replied" relies on.
- **`mail.message.sent`:** messages the user sent from any client.
- **`mail.message.labels_changed`:** read/unread, starred, archived, labeled, with labels added and removed.

Rules:
- Insert with a **`dedupe_key`**, for example connection + message id + change type, so re-syncs are harmless.
- Mark **`self_caused`** when the change matches a recent `audit_log` write by Winston, like his own send or archive.
- Advance `sync_state.historyId` **only after** events are safely stored.

Tests with recorded history fixtures: each change type, `is_reply_to_user` cases, dedupe on re-run, self-caused matching, the expired-history fallback, and the checkpoint only advancing on success.

## As built

- `syncMail` in `apps/agents/src/connections/sync-mail.ts`, run by the `sync_connection` handler (`connections/sync.ts`; calendar joins in 6a3656); Gmail's history, profile, recent messages and labels in `@winston/connectors/gmail-sync`. Details in docs/design.md §3 (Mail sync as built).
- Tested on fixture history (each change type, `isReplyToUser`, dedupe on re-run, self-caused matching, the expired-history fallback, and a failure leaving the checkpoint alone) rather than recorded Gmail responses, so no real mail is in the repository.
- Stored events aren't matched to subscriptions yet; that's 463072.

