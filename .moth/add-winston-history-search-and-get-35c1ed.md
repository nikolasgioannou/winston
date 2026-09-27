---
id: "35c1ed"
title: Add winston history search and get
status: todo
priority: none
labels:
  - cli
  - db
  - m9
created_at: 2026-09-27T05:42:36.143Z
updated_at: 2026-09-27T05:42:36.220Z
blocked_by:
  - "1fd02f"
  - "d66d10"
  - "fe870e"
---

The front-of-house window scrolls away, and there's no history page on the site. So Winston answers "what restaurant did I mention in July?" and "did you actually send that?" himself, with `winston history` (docs/design.md §2 Message archive, §11).

It's built on **Postgres full-text search**, with no embeddings. That's a deliberate decision: agents rephrase and retry keyword queries well, and keyword search is exact on names, emails and order numbers.

Build:
- `tsvector` columns with GIN indexes on what's searchable: `inbound_items` (user messages and event text), `outbound_messages`, `audit_log` (what Winston did) and run results (past task reports). Research generated `tsvector` columns vs triggers, the right text search configuration (`english` vs `simple`; names and ids suggest `simple` for some fields, or combining both), and ranking with `ts_rank`.
- **`history search [<text>] [--type message|action|task] [--since] [--until] [--limit] [--cursor]`:** results ranked, and within similar rank, newest first. Each result is the **full item rendered in the same envelope format as the context window** (`<system_event>` with `<sent_at>` etc.), with its `hist_` id. The design wants search results and context to look identical.
- **`history get <hist_id|msg_id> [--context <n>]`:** one item, plus `n` items before and after, for context.
- Register `hist_` with the `winston get` resolver.

Update the front-of-house prompt briefly: use `winston history search` when something may have scrolled out of the window.

Tests: search across each type, ranking sanity, date filters, `--context` windows, envelope rendering identical to the context path, and user scoping (never another user's rows).
