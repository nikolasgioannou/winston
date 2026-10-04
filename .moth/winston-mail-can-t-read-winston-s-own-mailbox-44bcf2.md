---
id: "44bcf2"
title: winston mail can't read Winston's own mailbox
status: done
priority: none
labels:
  - cli
  - connectors
parent: "ead827"
created_at: 2026-10-04T02:55:27.437Z
updated_at: 2026-10-04T05:36:57.324Z
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

- [x] `winston mail list|search|get` and attachment download work with `--account <his address>`, matching Gmail's output shape
- [x] `winston mail update` and `delete` work on his messages
- [x] Tests cover the filters, paging and the `--native` refusal

## As built

`winstonMailProvider` (`@winston/connectors/winston-mail`) implements `MailProvider` over `mailbox_messages` and `mailbox_threads`, always scoped to the connection; the gateway uses it for connections whose provider is `winston`, and reads raw mail from blobs (`BLOB_BUCKET`/`BLOB_DIR`, read access granted in CDK) for attachments. Folders, the portable filters, cursor paging (date and id), threads oldest first, attachments by part number, `update` (read, starred, archived, his own labels) and `delete` (to `trash`). `--native` is `not_supported`, in search and in a subscription on his account. `accounts get` notes say what works and that it can't send yet. Tests cover each, plus that another mailbox's mail can't be read or changed.

**Differs from the plan:** organizing his mailbox records no `mail.message.labels_changed`: only Winston changes it, and his own changes are self-caused, which matching skips anyway, so the events would never be used.
