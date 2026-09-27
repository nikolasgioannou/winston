---
id: "5b4554"
title: Generate typed, prefixed ids
status: todo
priority: none
labels:
  - backend
  - m0
created_at: 2026-09-27T05:28:45.600Z
updated_at: 2026-09-27T05:28:45.629Z
blocked_by:
  - "ac22b7"
---

Every object in Winston has a prefixed id: `usr_`, `run_`, `task_`, `hist_`, `trg_`, `evn_`, `acct_`, `vm_`, `hnd_`, `file_`, `win_`, and so on (docs/design.md §11 Identifiers and §14). The CLI relies on the prefix to know what an id refers to, and `winston get <any-id>` resolves by prefix.

In `packages/shared`, add:
- A single registry mapping prefixes to entity names. That's the only place a new prefix gets added.
- A generator producing `<prefix>_<random>`. Research the options (nanoid, crypto-random base62, UUIDv7 encoded) and pick something URL-safe, shell-safe (no characters needing quoting), reasonably short for humans and agents to paste, and with enough entropy. Consider whether time-sortable ids help, since lists are "newest first."
- Branded TypeScript types per entity (a `UserId` can't be passed where a `RunId` is expected), plus a parser that validates the prefix and returns the entity kind.

Tests: generated ids match the pattern and prefix, parsing rejects unknown prefixes and malformed input, and branded types prevent mixing (a type-level test via `// @ts-expect-error`).
