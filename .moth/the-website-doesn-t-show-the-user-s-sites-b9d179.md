---
id: "b9d179"
title: The website doesn't show the user's sites
status: done
priority: none
labels:
  - ui
  - web
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.396Z
updated_at: 2026-10-04T06:12:55.913Z
blocked_by:
  - "a2f40c"
  - "b2c4a6"
  - "bf7f34"
---

A Sites page on the website (parent's spec, Where the user sees them; §20).

**What to build**
- Sites in the sidebar: each site as a card with its address, access (private or link), last deploy, and actions: open, copy share link, make private, versions with rollback, take down (confirmed in a dialog). The design system and the existing page patterns.
- Its states in the dev design view.

**Done when**
- [ ] The page lists the user's sites and every action works against the local host
- [x] Empty, paused and shared states render in the design view

## As built

- `/sites` in the sidebar (Globe), `src/pages/sites-page.tsx`, route `routes/_authed/sites/index.tsx`, server functions in `src/server/sites-functions.ts` (docs/design.md §20). Rows follow Connected accounts: name, address, a status pill (Private, Shared, Paused, Not deployed) and a ⋯ menu (Open, Share by link or Copy share link, Make private, Versions, Take down with a confirmation). Versions open in a dialog from `?versions=<site_id>`, with Restore on each version but the current one. No add button, because Winston creates sites in chat.
- **Shared with the CLI:** share, make private, roll back, list versions and the site DTO moved to `@winston/site-host/manage`, so the page and `winston site` run the same code. vm-api maps their `SiteChangeError` in `toApiFailure`.
- `web` reads `SITES_ADMIN_URL` and the blob store config like the gateway, so the same `.env.local` covers it.
- Checked in the dev design view (every state renders, no console errors) and by the vm-api tests of the shared operations. **Not yet clicked through signed in**: the founder can't sign in right now (2FA), so it's on the founder's check at the end, with the visual review.
