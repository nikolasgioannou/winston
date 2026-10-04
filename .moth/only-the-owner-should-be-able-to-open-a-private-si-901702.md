---
id: "901702"
title: Only the owner should be able to open a private site
status: backlog
priority: none
labels:
  - backend
  - infra
  - web
parent: "57e0e7"
created_at: 2026-10-04T02:55:07.085Z
updated_at: 2026-10-04T02:55:07.085Z
blocked_by:
  - "4bacc0"
---

Sites are private by default: only their signed-in owner can open them (parent's spec, Access).

**What to build**
- Visiting a private site without access redirects to `runwinston.com`, which (after sign-in if needed) checks the visitor owns the site and redirects back with a short-lived, single-use signed ticket. The dispatch Worker verifies it (a public key it holds, so no call back to us per request), then sets its own signed, host-only, HttpOnly cookie for that site and serves it.
- Someone who isn't the owner sees a plain "this site is private" page.
- Ticket and cookie formats documented in the Sites section of docs/design.md, and §13 updated.

**Done when**
- [ ] The owner opens a private site after signing in, and stays in on later visits
- [ ] A signed-out visitor and a different signed-in user are both refused
- [ ] A replayed, expired or other-site ticket is refused (tests)
