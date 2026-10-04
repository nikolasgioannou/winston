---
id: "2bf739"
title: Forwards and CCs from the user reach Winston as a stranger's mail
status: todo
priority: none
labels:
  - backend
  - events
parent: "ead827"
created_at: 2026-10-04T02:55:27.600Z
updated_at: 2026-10-04T02:55:34.755Z
blocked_by:
  - "9ad1b4"
---

When the user forwards a thread to Winston or CCs him ("deal with this"), it arrives like any stranger's mail, so he'd only act on it if he happened to have a subscription, and couldn't tell it apart from an impersonator (ead827).

**What to build**

- A message to his mailbox whose sender is one of the user's connected mail addresses or their sign-in email, **and** whose SES DKIM and DMARC verdicts pass, is the user speaking: always delivered to the front of house (no subscription), rendered by the server as the user's own words with the mail (and, for a forward, the forwarded thread) as `<data>`.
- The same sender failing the check is stored as outside mail, and the front of house is told, so it can warn the user in Telegram that someone may be impersonating them.
- Envelope and catalog changes in `@winston/domain/envelope` and `/events`. This extends Invariant 3 (agreed with the founder 2026-10-03), and `design.md` Part 3 and §4 say so.
- Tests: a verified forward and CC, a spoofed `From` (DKIM fail), a DMARC fail, a sender who isn't the user, and tag-like text inside the mail staying escaped.

**Done when**

- [ ] A verified forward from the user reaches Winston as the user speaking, with no subscription
- [ ] A spoofed one doesn't, and the user is warned
- [ ] The envelope tests pass and `design.md` describes the extended invariant
