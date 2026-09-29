---
id: "ea7ecd"
title: Add web session and Telegram link token tables
status: done
priority: none
labels:
  - db
  - m3
created_at: 2026-09-27T05:34:40.394Z
updated_at: 2026-09-29T02:54:00.083Z
blocked_by:
  - "762cf0"
---

Sign-in and Telegram linking need two more tables from docs/design.md §14:
- **`web_sessions`:** the session id, `user_id`, `token_hash` (the raw token only ever lives in the cookie), `expires_at`, `created_at`. Add an index for cleanup, and a periodic job (or opportunistic cleanup) that deletes expired sessions.
- **`telegram_link_tokens`:** `token_hash`, `user_id`, `expires_at` (~15 minutes) and `used_at`. Telegram deep-link payloads are limited to 64 characters of `[A-Za-z0-9_-]`, so the raw token format must fit that. Generate and validate it in one helper, and test the constraint.

Tests: the token helpers (format, length, constant-time comparison via the shared hashing helper), expiry logic, and single-use enforcement for link tokens.

## Outcome

- `web_sessions` (`ses_` ids, unique `token_hash`, `expires_at`, indexes on `expires_at` and `user_id`) and `telegram_link_tokens` (`token_hash` PK, `user_id`, `expires_at`, `used_at`), both cascading with the user.
- `@winston/db/web-sessions`: `createSession` (raw token returned once; 30-day lifetime; deletes expired sessions as it goes, instead of a scheduled job), `findSession` (by token hash, unexpired only), `deleteSession`.
- `@winston/db/telegram-link-tokens`: `isLinkTokenFormat` (Telegram's 64-character `[A-Za-z0-9_-]` rule), `issueLinkToken` (43-character base64url token, 15-minute expiry, deletes expired tokens), `consumeLinkToken` (one conditional UPDATE, so single use holds under races).
- Tokens are looked up by their SHA-256 (the shared `hashToken`), so the raw token is never stored or compared; a separate constant-time comparison isn't needed.
- Tests cover format and length, hash-only storage, expiry boundaries, single use, unknown and malformed tokens, and cleanup.

