---
id: "480aff"
title: "Build the connector framework: providers, permission enforcement and the
  audit log"
status: done
priority: none
labels:
  - backend
  - connectors
  - m5
created_at: 2026-09-27T05:37:39.030Z
updated_at: 2026-10-01T16:07:16.818Z
blocked_by:
  - "6882fb"
  - "8251fd"
  - "89a2b0"
---

Before any mail or calendar command, the shared machinery has to exist in the VM-facing API (docs/design.md §3 Handling provider differences, §5 Permissions, §11). Two invariants live here: **permissions are enforced by the server on every call**, and **everything Winston does is recorded**.

Build:
- **Provider interfaces:** `MailProvider` and `CalendarProvider`, holding the normalized domain models from §3 (messages, threads, drafts, attachments / events, attendees, RSVP). Gmail and Google Calendar will be the only implementations, but code against the interface.
- **Account resolution:** `--account <email|acct_id>` resolves to a connection for the right domain (aliases were removed in M3). With no flag and exactly one connection, use it. Otherwise return an error listing the choices.
- **Enforcement middleware:** each route declares the capability it needs (`mail.send`, `calendar.rsvp`, …). A disabled capability returns `permission_disabled` with a hint pointing at `runwinston.com/accounts/<acct_id>`. An expired connection returns `auth_expired` with the reconnect link. An operation the provider doesn't support returns `not_supported`.
- **The `audit_log` table and writer:** every write records the run, connection, action, target, a redacted request summary and the outcome. It's written *before* the provider call returns, so M7's `self_caused` detection can match events against it.
- **Id mapping:** CLI ids (`msg_`, `thr_`, `drf_`, `att_`, `evt_`) must resolve back to a connection and a provider id. Decide how: for example, encode the connection and provider id into the id deterministically, or keep a lookup table. It must work with `winston get <any-id>` later. Record the choice in §11 Identifiers.

Tests: enforcement for each error code, account resolution cases, audit rows written for writes (not reads), and id round-tripping.

**Done (2026-10-01):** ids map through an `external_refs` table (TypeID suffixes can't carry provider ids). The gateway gets providers, KMS decrypt and the Google client with the Gmail ticket (6af84b), since nothing calls a provider before then.
