---
id: "44bcf2"
title: winston mail can't read Winston's own mailbox
status: todo
priority: none
labels:
  - cli
  - connectors
parent: "ead827"
created_at: 2026-10-04T02:55:27.437Z
updated_at: 2026-10-04T02:55:34.597Z
blocked_by:
  - "9ad1b4"
---

Winston's own mailbox is stored in Postgres (after inbound mail), but `winston mail` can only read Gmail (ead827). The founder wants the same commands to work on both.

**What to build**

- The read half of `MailProvider` over the stored mail: list and search with the portable filters (`--in`, `--from`, `--to`, `--subject`, `--unread`, `--has-attachment`, `--label`, `--since`, `--until`), get a message or thread, attachments (info and save to the VM), with the same ids, output and paging as Gmail.
- `--native` isn't supported on this provider (exit 7, suggesting the portable flags), and `winston accounts get` says so.
- Read/unread, starred, archived and labels on his messages (`winston mail update`), and delete to trash, so he can organize his inbox; `mail.message.labels_changed` as for Gmail.
- Subscription filters work on his account (`passesFilter`; no native query).
- `design.md` §3 and §11 updated.

**Done when**

- [ ] `winston mail list|search|get` and attachment download work with `--account <his address>`, matching Gmail's output shape
- [ ] `winston mail update` and `delete` work on his messages
- [ ] Tests cover the filters, paging and the `--native` refusal
