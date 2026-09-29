---
id: "244f55"
title: Sign in with Google, gated by the email allowlist
status: done
priority: none
labels:
  - backend
  - m3
  - web
created_at: 2026-09-27T05:34:40.442Z
updated_at: 2026-09-29T03:09:56.800Z
blocked_by:
  - "801d97"
  - "ea7ecd"
  - "ef5b35"
---

The first real page. "Sign in with Google" is **identity only**: it requests `openid email profile`, never Gmail or Calendar (docs/design.md §5, Connections & credentials). Only emails in `allowed_emails` get in (§5, Access control).

Research the OAuth flow implementation: Authorization Code with PKCE, where the callback lives (the design puts OAuth callbacks in `api`, but sign-in sets a cookie for `web`, so decide deliberately and note it in §9), verifying the ID token (issuer, audience, `email_verified`), and cookie settings (HttpOnly, Secure, SameSite, domain scoping across `runwinston.com` and `api.runwinston.com`). Consider a well-maintained library such as `arctic` for the OAuth mechanics, rather than hand-rolling.

Behaviour:
- Unknown email: reject **before** creating any user or VM, and show the "not allowlisted" state.
- First sign-in: create the user with `first_name`/`last_name` from `given_name`/`family_name`, and the time zone from the browser, sent along with the sign-in.
- Sessions in `web_sessions`. Sign-out clears them.
- A server-side session helper and route guard that later pages use.

The `/signin` page uses `packages/ui` only, with its states: default, redirecting, not allowlisted, OAuth error. It's the first page. The dev design view gets built right after, so structure page states so they're easy to render in isolation.

Tests: allowlist rejection creates nothing, first sign-in creates the user with names, repeat sign-in reuses it, and ID token validation failures. Stub Google's endpoints.

## Outcome

- Identity-only sign-in with Google, Authorization Code + PKCE, written by hand (arctic was deprecated in 2026-07; its reference code was followed). The callback lives in `web` because it sets the site's host-only session cookie; noted in §9.
- ID token: issuer, audience, expiry and `email_verified` checked with Zod; the signature isn't, as Google allows for tokens taken straight from its token endpoint.
- Allowlist checked by email (case-insensitive) before anything is created. Users are found by a new `users.google_sub` (unique), then by email (attaching the `sub`, which is how the seeded user links), or created with Google's names and the browser's time zone. An email tied to a different Google account is refused.
- Session cookie: HttpOnly, SameSite=Lax, host-only, 30 days; Secure and `__Host-` prefixed over https. Sign-out is a POST. Guard: an `_authed` layout with `beforeLoad` and a `getSessionUser` server function; `/home` is a placeholder.
- `/signin` uses `packages/ui` only, with its states as a prop for the dev design view.
- The site now reads `.env.local` under `bun dev`; `WEB_PUBLIC_URL` defaults to localhost. A production build confirmed no server code in the client bundle.
- Tests: the authorization URL and PKCE (RFC 7636's example), the code exchange, ID token rejections (issuer, audience, expiry, unverified email, no subject, endpoint errors), allowlist rejection creating nothing, first sign-in with names and time zone, reuse, linking the seeded user, refusing a different Google account, and the callback's state checks.

