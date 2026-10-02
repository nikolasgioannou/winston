---
id: "35c1ed"
title: Add winston history search and get
status: done
priority: none
labels:
  - cli
  - db
  - m9
created_at: 2026-09-27T05:42:36.143Z
updated_at: 2026-10-02T18:09:52.942Z
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

## As built

- **FTS:** stored generated `tsvector` columns (no triggers) with GIN indexes on `inbound_items` (`jsonb_to_tsvector` over the payload's strings), `outbound_messages` and `audit_log`. Each is `english` || `simple`, so stems and exact names, emails and ids both match; queries are `websearch_to_tsquery` in both configurations, ORed. Run results needed no column: task reports are already `task.completed` inbound items.
- **Kinds:** `message` (the user's and Winston's), `event`, `task`, `action`; `event` was added because inbound events are searchable too.
- **Rendering:** the same path as the context window (`toEnvelopeItems`, moved to `@winston/db/envelopes`, then `renderBatch`); Winston's messages render as `winston.message`, actions as `winston.action`. Each result is printed under its `hist_` id.
- **Ids:** audit rows got `history_id` (`hist_`), backfilled in the migration for existing rows, so actions work with `history get` and `winston get`.
- **Ranking:** `ts_rank` rounded to two places, then newest first; offset cursors.
- `history get <hist_id> --context n` (msg_ ids are mail; `winston mail get` covers those). Neighbours are ordered by the stored time to the microsecond.
- Prompts: front of house searches before saying it doesn't know; the background prompt mentions it in a line.
- Tests: each kind, stemming and exact ids, ranking, type and date filters, cursors, `--context`, envelopes identical to the context path, user scoping; CLI output and `winston get hist_…` routing.
