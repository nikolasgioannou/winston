---
id: "b0717f"
title: Make the sign-in page the front door, without public pages
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:40.620Z
updated_at: 2026-09-30T02:43:48.168Z
blocked_by:
  - "5e3c6d"
---

The ticket first asked for a public homepage, privacy policy and terms, which Google's OAuth consent screen asks for. With Winston only for the founder's friends, the founder decided against public pages for now (2026-09-29): `/` becomes the sign-in page.

- `/` is the sign-in page (signed-in visitors go to `/home`); `/signin` goes away, and the guard, sign-out and sign-in errors point to `/`.
- No homepage, privacy policy or terms. Google requires them only to verify the app for general use; testing mode works without them. The Google Cloud runbook and docs/design.md §9 record what's needed before any verification.

## Outcome

- Drafted first, then removed at the founder's request: a homepage (with a Telegram-style chat preview), a privacy policy and terms. Research on Google's requirements (Limited Use wording, User Data Policy rules for restricted scopes, the AI training ban, homepage and branding rules) is summarized in docs/design.md §9 and the runbook for when they're needed.
- Kept from that work: the model gateway sets OpenRouter's `data_collection: "deny"` for every profile, so users' email and calendar only go to providers that neither train on nor keep it (checked live that Anthropic still serves; the gateway test asserts it).
- `/` is the sign-in page; `/signin`, `/privacy` and `/terms` don't exist. The unauthenticated guard, sign-out and sign-in errors (`/?error=not_allowlisted|oauth`) all land on `/`. Google's redirect URI (`/auth/google/callback`) is unchanged.
- Checked: `/` renders sign-in and its error state, `/home` signed out redirects to `/`, sign-out lands on `/`, and the removed routes 404.
