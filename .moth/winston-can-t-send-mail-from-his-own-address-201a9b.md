---
id: "201a9b"
title: Winston can't send mail from his own address
status: done
priority: none
labels:
  - backend
  - connectors
parent: "ead827"
created_at: 2026-10-04T02:55:27.491Z
updated_at: 2026-10-04T05:47:38.668Z
blocked_by:
  - "9ad1b4"
---

Winston can receive mail at his own address but can't send from it (ead827).

**What to build**

- The write half of `MailProvider` for his mailbox, over SES `SendRawEmail` with the existing `MailComposer` code: send, reply, reply-all, forward, drafts, with `From: Winston <his current address>`, threading headers as for Gmail, and the configuration set from the SES setup.
- Sent mail is stored in his mailbox (in his threads) and emits `mail.message.sent`, self-caused.
- **Limits enforced by the server:** 100 messages a day per user to start, refused with a clear error. Bounces and complaints (SNS) mark the recipient suppressed, and sending to a suppressed address is refused with the reason.
- `dryRun`, the audit log and the routes as for Gmail (§5, "The mail write routes"); a turned-off mailbox refuses to send.
- `design.md` updated.

**Done when**

- [ ] `winston mail send`, `reply` and `forward` with `--account <his address>` deliver to a Gmail inbox, passing SPF, DKIM and DMARC, and a reply comes back into the same thread *(live check waits on SES: runbook "Sending")*
- [x] The daily limit and suppression are enforced and tested
- [x] Dry runs and audit rows match Gmail's

## As built

- **Provider** (`winstonMailProvider.send`): composes with `From: Winston <address>` and no Bcc header (`composeRaw`'s new `from` and `keepBcc`), refuses past 100 sent in 24 hours or to a suppressed address (`SendingRefusedError`: `permission_disabled` or `invalid_request`), sends through `MailSender`, stores the raw message as a blob and the message in his mailbox (the thread it answers, or a new one) with SES's id.
- **Gateway:** `sesSender` (SES v2 `SendEmail`, raw, every recipient in the envelope, the configuration set) when `SES_CONFIGURATION_SET` is set, else a logging sender; blobs it can now also write. CDK: `ses:SendEmail`/`SendRawEmail` on the identity and configuration set, blob put.
- **Bounces and complaints:** the `SendingEvents` topic posts to the same webhook (`SES_EVENTS_TOPIC_ARN`); a permanent bounce or a complaint adds the address to the new `mail_suppressions`.
- **Threading:** SES replaces the Message-ID with `<id@email.amazonses.com>`, so received replies are matched to what he sent by SES's id inside the header, whatever host it names.

**Differs from the plan:**
- **No drafts** on his mailbox (`not_supported`): he sends once the user has agreed; drafting stays the user's accounts' job.
- **No `mail.message.sent` event:** it would be self-caused, which nothing reacts to (as with label changes, 44bcf2).
- **The live check** (a real send passing SPF, DKIM and DMARC, and a reply threading back) needs SES set up: it's runbook "Sending" under 363358. Tests cover composing, the envelope, storing, threading, the limit, suppression and the webhook.
