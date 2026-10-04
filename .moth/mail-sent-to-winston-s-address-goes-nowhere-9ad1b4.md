---
id: "9ad1b4"
title: Mail sent to Winston's address goes nowhere
status: todo
priority: none
labels:
  - backend
  - events
parent: "ead827"
created_at: 2026-10-04T02:55:27.383Z
updated_at: 2026-10-04T02:55:34.545Z
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

- [ ] A message to `<name>@runwinston.email` (and to an alias) is stored and fires a matching `mail.message.received` subscription within seconds
- [ ] A reply to it lands in the same thread
- [ ] Mail to a turned-off or unknown address is refused, and a re-delivered notification stores nothing twice
- [ ] Tests cover signature checks, parsing (multipart, attachments, charsets) and threading
