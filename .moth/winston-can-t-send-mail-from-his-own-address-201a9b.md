---
id: "201a9b"
title: Winston can't send mail from his own address
status: todo
priority: none
labels:
  - backend
  - connectors
parent: "ead827"
created_at: 2026-10-04T02:55:27.491Z
updated_at: 2026-10-04T02:55:34.650Z
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

- [ ] `winston mail send`, `reply` and `forward` with `--account <his address>` deliver to a Gmail inbox, passing SPF, DKIM and DMARC, and a reply comes back into the same thread
- [ ] The daily limit and suppression are enforced and tested
- [ ] Dry runs and audit rows match Gmail's
