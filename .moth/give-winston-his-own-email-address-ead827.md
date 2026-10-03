---
id: "ead827"
title: Give Winston his own email address
status: backlog
priority: none
labels:
  - collab
  - connectors
  - spec
created_at: 2026-10-03T16:31:57.384Z
updated_at: 2026-10-03T16:32:04.612Z
---

**Needs a spec with the founder before any building.** The founder's idea (2026-10-03), captured at a high level.

Each user's Winston gets an email address of his own, so he can sign up for things in his own name and people can include him in mail.

The idea:
- **Choosing it at sign-up:** an onboarding step where the user picks their Winston's address.
- **His own inbox:** sign-up confirmations and verification codes go to him, not the user's Gmail.
- **CLI:** `winston` commands to manage his mailbox (read, send, organize, maybe filters).
- **Forwarding:** the user forwards a thread to Winston to hand it off ("deal with this").
- **CC:** the user adds Winston to a thread, e.g. to schedule a meeting with the other people on it.

Questions the spec must answer:
- **Domain and addresses:** e.g. `name@winston.email` or a subdomain of runwinston.com; who picks the name; uniqueness; what if a user wants to change it.
- **Provider:** sending and receiving (e.g. SES inbound + outbound, Postmark, a hosted mailbox). Deliverability: SPF, DKIM, DMARC, warm-up, and staying off spam lists.
- **Arrival:** how inbound mail reaches Winston: as events (the catalog, triggers), as `user_message`-like items when the user forwards or CCs him, or both.
- **Trust:** mail from strangers is outside content (§4). When Winston acts on a CC'd thread, who is he acting for, and what does confirm-first mean when the user isn't the sender?
- **Voice:** he signs as "Winston, on behalf of …". How replies to his own address thread back in.
- **Abuse and limits:** sending limits and spam prevention; what happens to the address when an account is deleted.
- **Product changes:** product.md lists "Winston's own email address" as out of scope (and its browser section says verification codes are read through Gmail); this reverses that.
- How it relates to the user's connected Gmail (two mailboxes, which one to use when).
