---
id: "2bf739"
title: Forwards and CCs from the user reach Winston as a stranger's mail
status: done
priority: none
labels:
  - backend
  - events
parent: "ead827"
created_at: 2026-10-04T02:55:27.600Z
updated_at: 2026-10-04T05:56:43.955Z
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

- [x] A verified forward from the user reaches Winston as the user speaking, with no subscription
- [x] A spoofed one doesn't, and the user is warned
- [x] The envelope tests pass and `design.md` describes the extended invariant

## As built

- **The check** (`apps/agents/src/mailbox/receive.ts`): the sender is the user's sign-in email or one of their connected (not disconnected) mail accounts, case-insensitively, and SES's DKIM and DMARC verdicts are both PASS.
- **Proven:** the message is stored in his mailbox as usual, and a `user_email` inbound item (always delivered, wakes the front of house) carries his address, the sender, to/cc, subject, the CLI message and thread ids, the user's own words (the body above a forwarded message, `splitForwarded` in `@winston/connectors/mail-body`), the forwarded message and attachment names. `renderUserEmail` is the only renderer of it: the user's words as `<text>`, the rest as escaped `<data>`; `renderEvent` refuses the type. No `mail.message.received` for it: it reaches him as the user, not as news.
- **Unproven:** stored and announced as outside mail like any other, plus a `mail.impersonation.suspected` item (always delivered) with the claimed sender and the verdicts, so the front of house can warn the user. Telling him how to word the warning is the prompts ticket (664563).
- Invariant 3 and §4 in `design.md` now name `user_email` beside `user_message`; the catalog has both new events.

**Differs from the plan:** the forwarded thread isn't rendered inline as a whole thread; the envelope carries the forwarded text and the ids, and `winston mail get thr_…` reads the rest.
