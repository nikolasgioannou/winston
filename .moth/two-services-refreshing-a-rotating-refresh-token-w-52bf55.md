---
id: "52bf55"
title: Two services refreshing a rotating refresh token would lose the grant
status: done
priority: none
labels:
  - backend
  - connectors
  - infra
parent: "80fcf0"
created_at: 2026-10-05T23:00:51.851Z
updated_at: 2026-10-05T23:39:24.248Z
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

- [x] A test with two concurrent callers refreshes once and both get the same access token
- [x] A test where the provider rotates the refresh token stores the new one, and the next refresh uses it
- [x] `invalid_grant` expires the connection and records one event
- [x] `design.md` §5 (Access control, access tokens) describes rotating providers


## As built

- **`rotatingAccessTokens`** (`packages/connectors/src/rotating-tokens.ts`) takes the provider's `refresh` (refresh token in; access token, lifetime and maybe a new refresh token out, or `"invalid_grant"`), so 8f6c44 supplies Ramp's token endpoint. A caller uses its memory, then the stored access token without a lock while it has over a minute left, and only otherwise locks the row, re-reads it, refreshes and stores both sealed tokens before committing.
- **Schema:** `access_token_ciphertext` and `access_token_expires_at` on `connections` (migration `rotating_access_tokens`), sealed with `accessTokenContext` (`{ connectionId, token: "access" }`) so an access token can't be opened as a refresh token. A new grant, revoking and account deletion clear them.
- **Tests:** two helpers called at once refresh once and both get `a1`. Removing the row lock makes that test fail, so it tests the lock. The rotation test also shows a second helper with nothing in memory using the stored token. `invalid_grant` expires the connection with one `system.app.auth_expired`.
- **Differs from the plan:**
  - The gateway's `kms:GenerateDataKey` grant moved to 02441f, where the gateway first refreshes Ramp tokens. Nothing uses the helper yet, and the infra test deliberately asserts the gateway never seals.
  - The grant sweep doesn't read `refresh_token_expires_in` yet: whether Ramp sends one is the spike's question (aa06d1), and 8f6c44 adds it if it does.
