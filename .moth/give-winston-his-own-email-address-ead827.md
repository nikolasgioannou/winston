---
id: "ead827"
title: Give Winston his own email address
status: in-progress
priority: none
labels:
  - collab
  - connectors
  - spec
created_at: 2026-10-03T16:31:57.384Z
updated_at: 2026-10-04T02:55:26.986Z
---

The founder's idea (2026-10-03), specified together the same day. The work is filed as sub-tickets under this one.

Each user's Winston can have an email address of his own, `<name>@runwinston.email`. He uses it to sign up for things in his own name (the first example: a GitHub account so he can push to this repo), and the user forwards mail to him or CCs him to hand work off ("deal with this", "find a time for the three of us").

## Spec

**The address**

- **Opt-in, from the site.** It isn't part of onboarding. The user turns it on from a new **Channels** page (`/channels`, "the ways you reach Winston"), which also takes Telegram over from Profile, and picks the name then. Winston can send the user a link to that page when he needs an address.
- **Domain: `runwinston.email`**, kept apart from `runwinston.com` (the site and sign-in) and `runwinston.app` (apps Winston deploys), so a deliverability problem with his mail can't touch either. Bought through Cloudflare Registrar; DNS on Cloudflare like the main domain.
- **Names:** chosen by the user, unique, lowercase letters, digits, dots and hyphens; reserved names (`admin`, `postmaster`, `abuse`, `support`, `noreply` and the like) are refused.
- **Never reused.** An address belongs to the user who took it for good. Changing it keeps the old one as an alias that still delivers to the same mailbox; a user may change it **twice in total**. When an account is deleted its addresses are retired, never released, so nobody else can receive password resets for what that Winston signed up for.
- **Turning it off** stops sending and receiving (incoming mail bounces) but keeps the address reserved; turning it on again brings back the same address and mailbox.
- **Display name:** "Winston", fixed.

**The mailbox**

- **Provider: Amazon SES** (us-east-1), inbound and outbound. Inbound mail is written to S3 and announced to the `api`, which stores it; we keep his mail in Postgres (raw messages in S3) until the account is deleted.
- **It's a mail account like any other** behind the `MailProvider` interface (§3, "Handling provider differences"), with its own provider: the `winston mail` commands, `--account`, `mail.*` events, subscriptions and filters, the audit log and dry runs all work on it as on Gmail. It isn't listed under Connected accounts on the site, since it's a channel rather than the user's data, and it has no capability switches; limits are enforced by the server instead (sending limits, below).
- **Arrival:** Winston subscribes to his own inbox's events, as he does to the user's Gmail. The exception is the user speaking (next).

**Trust**

- **A forward or CC from the user counts as the user speaking** when SES's DKIM and DMARC verdicts pass and the sender is one of the user's connected mail addresses or their sign-in email. It's always delivered (no subscription needed) and the server renders it as the user's own words, with the mail inside `<data>`. This extends Invariant 3 ("only the server creates `user_message` envelopes"), agreed with the founder 2026-10-03: the server still creates it, from a verified email as well as from Telegram.
- **Mail that claims to be from the user but fails the check** is outside mail like any stranger's, and Winston warns the user in Telegram that someone may be impersonating them.
- **Everything else is outside content** (§4), never instructions.
- **Acting on a CC'd thread:** a request from the user in the thread ("Winston, find us a time") is the confirmation for acting on it, so he replies to the thread without asking in Telegram first. Anything beyond the request still follows confirm-first.

**Which address he uses**

- **His own**, when it's on and the thread is his: mail forwarded to him, threads he's CC'd on, replies to mail sent to him, and signing up for things.
- **The user's Gmail** for the user's own threads, as today, signed "Winston, on behalf of <first name>".

**Abuse and limits**

- Sending limits per user per day, enforced by the server (100 to start); bounces and complaints from SES suppress the address he sent to.
- SES's spam and virus verdicts are stored with each message; mail flagged as a virus isn't stored.

**Out of scope:** a phone number of his own; two-factor secrets for accounts he signs up for (6457ed); filters or rules on his mailbox beyond subscriptions.

**Docs:** `product.md` lists "Winston's own email address" as out of scope and says verification codes are read through Gmail. Each sub-ticket updates `product.md` and `design.md` for what it builds.

**Done when**

- [ ] Every sub-ticket is done
- [ ] A user can turn the address on, Winston can sign up for a service with it and read its verification code, and a thread the user CCs him on gets a reply from his address
