---
id: "ea7ecd"
title: Add web session and Telegram link token tables
status: todo
priority: none
labels:
  - db
  - m3
created_at: 2026-09-27T05:34:40.394Z
updated_at: 2026-09-27T05:34:40.426Z
blocked_by:
  - "762cf0"
---

Sign-in and Telegram linking need two more tables from docs/design.md §14:
- **`web_sessions`:** the session id, `user_id`, `token_hash` (the raw token only ever lives in the cookie), `expires_at`, `created_at`. Add an index for cleanup, and a periodic job (or opportunistic cleanup) that deletes expired sessions.
- **`telegram_link_tokens`:** `token_hash`, `user_id`, `expires_at` (~15 minutes) and `used_at`. Telegram deep-link payloads are limited to 64 characters of `[A-Za-z0-9_-]`, so the raw token format must fit that. Generate and validate it in one helper, and test the constraint.

Tests: the token helpers (format, length, constant-time comparison via the shared hashing helper), expiry logic, and single-use enforcement for link tokens.
