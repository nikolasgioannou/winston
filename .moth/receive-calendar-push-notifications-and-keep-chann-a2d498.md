---
id: "a2d498"
title: Receive Calendar push notifications and keep channels alive
status: todo
priority: none
labels:
  - connectors
  - events
  - m7
created_at: 2026-09-27T05:40:24.514Z
updated_at: 2026-09-27T05:40:24.568Z
blocked_by:
  - "403364"
  - "9c407f"
---

Google Calendar pushes directly to our HTTPS endpoint through `events.watch` channels, with no Pub/Sub needed (docs/design.md §3).

Build:
- **Channels:** for each calendar connection, one channel per watched calendar (the calendars the list command considers the user's). Each channel has a random **channel token** we verify on every notification. Store channel ids, resource ids and expirations.
- **`POST /webhooks/calendar` in `api`:** verify the `X-Goog-Channel-Token` and channel id, ignore the initial `sync` message type, and enqueue a deduped `sync_connection` for that connection. Respond fast.
- **Renewal:** channels expire. Check the current maximum lifetime in the docs. The daily `renew_watches` job (shared with Gmail) creates new channels before old ones expire, overlapping briefly rather than leaving gaps. Stop old channels afterwards.
- On disconnect, stop all channels.
- Locally, the tunnel URL makes this work. Google requires HTTPS with a valid certificate, so note whether the chosen tunnel satisfies that.

Tests: token verification, sync-message ignoring, renewal overlap logic, and stop on disconnect with a mocked API.
