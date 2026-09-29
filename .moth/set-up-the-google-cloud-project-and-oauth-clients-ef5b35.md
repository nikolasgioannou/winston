---
id: "ef5b35"
title: Set up the Google Cloud project and OAuth clients (with the founder)
status: done
priority: none
labels:
  - collab
  - infra
  - m3
created_at: 2026-09-27T05:34:40.232Z
updated_at: 2026-09-29T00:31:01.463Z
blocked_by:
  - "16c290"
---

Sign-in and connected accounts both need a Google Cloud project. The OAuth consent screen and clients are configured by hand, because Google barely exposes them through APIs. Pub/Sub comes later via Terraform (docs/design.md §5 Access control, §3 notifications, §8a).

Work through this with the founder, since it happens in their Google account:
- Create one GCP project for Winston. Enable the Gmail API and Google Calendar API.
- Configure the OAuth consent screen in **testing** mode. App name, support email, and homepage/privacy/terms URLs on `runwinston.com`: the pages don't exist yet (M3 public-pages ticket), so note it and fill them in once they're live. Add scopes: `openid email profile`, `gmail.modify` (read, labels, archive), `gmail.send`, `gmail.compose` (drafts), `calendar.events` and `calendar.readonly`, or whatever minimal set covers the capabilities in §5. Research the exact scopes needed for each capability and pick the narrowest set.
- Add the founder's Google accounts (personal and work) as **test users**. Remember the gotcha: every account that signs in *or* gets connected must be on this list.
- Create two OAuth clients: **dev** (redirect URIs on the local/tunnel URL) and **production** (`runwinston.com` and `api.runwinston.com` callbacks). Decide whether sign-in and connections share a client with different scopes, or use separate clients, and note why.
- Put the dev client credentials in `.env.local`, and add their names to `.env.example`.

Write the manual steps into `docs/runbooks/google-cloud.md`, so this can be repeated. Check early whether the founder's work Workspace blocks unverified apps (product.md open questions) and record the answer.

## Outcome

- Project `winston-510100` ("Winston", owned by `ni@nikolas.ai`) with the Gmail and Calendar APIs, an External consent screen in Testing, test users `ni@nikolas.ai` and `nikolasgioannou@gmail.com`, and two Web clients, `Winston dev` (localhost redirects for web on 3002 and api on 3000) and `Winston production`. Branding links wait for the public pages.
- Scopes: `openid email profile`, `gmail.modify` (covers every mail capability), `calendar.events`, `calendar.calendarlist.readonly`, `calendar.events.freebusy`.
- Decided: one client per environment for sign-in and connections, because revocation is project-wide, so separate clients isolate nothing; disconnecting a connection deletes its token instead of revoking. Sign-in-only accounts don't need to be test users (design doc corrected).
- `ni@nikolas.ai` authorized `gmail.modify` via the OAuth Playground without a Workspace block. Dev credentials are in `.env.local` (names in `.env.example`); steps and reasoning in docs/runbooks/google-cloud.md.
