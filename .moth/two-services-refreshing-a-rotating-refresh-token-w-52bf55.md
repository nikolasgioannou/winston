---
id: "52bf55"
title: Two services refreshing a rotating refresh token would lose the grant
status: todo
priority: none
labels:
  - backend
  - connectors
  - infra
parent: "80fcf0"
created_at: 2026-10-05T23:00:51.851Z
updated_at: 2026-10-05T23:01:41.927Z
blocked_by:
  - "74641a"
---

Google's refresh tokens never change, so `googleAccessTokens` caches access tokens in each process's memory, and both the gateway and agents refresh on their own. Ramp's refresh tokens rotate (Ramp's CLI guards against "another process may have already rotated this token family"). Two processes refreshing at once would replay a spent token, and Ramp may revoke the grant. The spike (aa06d1) confirms how Ramp behaves.

**What to build**

- An access-token helper for providers that rotate, used by every connector call: take a row lock on the connection (`SELECT … FOR UPDATE`), re-read the sealed tokens, refresh only if the stored access token is about to expire, then store the new refresh token (and the access token with its expiry, sealed) before releasing the lock. So the gateway and agents share one access token instead of each refreshing.
- The gateway needs `kms:GenerateDataKey` on the tokens key to seal (`infra/src/services.ts`); update the comment and `design.md` §13 if it describes who can seal.
- `invalid_grant` marks the connection `expired` with the once-per-grant `system.app.auth_expired` event, as for Google. If the token response gives `refresh_token_expires_in`, the grant sweep warns from that.
- Google keeps its current helper, unchanged.

**Done when**

- [ ] A test with two concurrent callers refreshes once and both get the same access token
- [ ] A test where the provider rotates the refresh token stores the new one, and the next refresh uses it
- [ ] `invalid_grant` expires the connection and records one event
- [ ] `design.md` §5 (Access control, access tokens) describes rotating providers
