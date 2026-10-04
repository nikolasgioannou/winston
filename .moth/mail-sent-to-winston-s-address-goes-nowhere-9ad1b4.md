---
id: "9ad1b4"
title: Mail sent to Winston's address goes nowhere
status: done
priority: none
labels:
  - backend
  - events
parent: "ead827"
created_at: 2026-10-04T02:55:27.383Z
updated_at: 2026-10-04T05:29:08.218Z
blocked_by:
  - "32ddbd"
  - "363358"
---

Mail sent to Winston's address lands in S3 (after the SES setup) but nothing reads it, stores it or tells Winston (ead827).

**What to build**

- `POST /webhooks/ses` on the `api`: verifies the SNS message signature (and confirms the subscription), then queues a job; a bad signature is 401, unknown or malformed data is acknowledged.
- The job reads the raw message from S3, finds the mailbox by any of its addresses (refusing a turned-off, unknown or retired one), parses the MIME and stores the message in Postgres with its thread (threaded by `References`/`In-Reply-To`), attachments, and SES's verdicts (SPF, DKIM, DMARC, spam, virus). Virus-flagged mail isn't stored.
- Emits `mail.message.received` for his account through the existing matching, with the same payload as Gmail's (`isReplyToUser` means a reply to Winston's own message), deduplicated by the SES message id.
- Account deletion deletes the stored mail and its S3 objects (§13).
- `design.md` §3 (how his mail arrives) updated.

**Done when**

- [x] A message to `<name>@runwinston.email` (and to an alias) is stored and fires a matching `mail.message.received` subscription within seconds
- [x] A reply to it lands in the same thread
- [x] Mail to a turned-off or unknown address is refused, and a re-delivered notification stores nothing twice
- [x] Tests cover signature checks, parsing (multipart, attachments, charsets) and threading

## As built

- **Webhook** (`apps/api/src/routes/ses-webhook.ts`, `apps/api/src/sns.ts`): SNS signature version 2 only, the certificate URL on SNS's own host (cached per URL), the expected topic; confirms its own subscription (the SubscribeURL checked to be SNS's); a `Received` notice queues `receive_mail` (deduplicated by SES's id).
- **Job** (`apps/agents/src/mailbox/receive.ts`): parses with postal-mime 4.0.4 (`@winston/connectors/mail-parse`; no dependencies), keeps the raw message as a blob (so account deletion's blob cleanup covers it), threads by `In-Reply-To`/`References`, stores in the new `mailbox_threads`/`mailbox_messages`, emits `mail.message.received` with Gmail's payload, and matches subscriptions. Bodies read through `readableBody`, moved out of the Gmail connector into `mail-body.ts` so both providers read mail the same way.
- **CDK:** the inbound topic subscribed to `https://api.runwinston.com/webhooks/ses`; api gets `SES_INBOUND_TOPIC_ARN`, agents `INBOUND_MAIL_BUCKET`, read and delete on it, and `ses:SendBounce` on the identity.
- **Locally:** `bun run mail:receive <file.eml> [--to …]` leaves the message where SES would and queues the same job.

**Differs from the plan:**
- **Refusing mail is a bounce after the fact.** SES's S3 action accepts everything for the domain, so mail to an unknown, retired or turned-off address is bounced with SES's `SendBounce` (`DoesNotExist`, from `mailer-daemon@runwinston.email`) rather than refused during SMTP, which would need a Lambda in the receipt rule. Infected mail is dropped without a bounce, since its sender is likely forged.
- **Spam is stored with a `spam` label and no event**, like Gmail's spam folder, rather than not stored.
- **The raw message moves to blob storage** and the inbound object is deleted once handled, so the inbound bucket only holds mail in flight.
- **Done-when boxes are checked by tests** (handler, webhook and parser) and the local script; the live round trip through SES is runbook step "Receiving" under 363358, once the domain's records are in.
