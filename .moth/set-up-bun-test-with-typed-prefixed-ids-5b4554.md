---
id: "5b4554"
title: Set up bun test with typed, prefixed ids
status: done
priority: none
labels:
  - backend
  - m0
created_at: 2026-09-27T05:28:45.600Z
updated_at: 2026-09-27T16:43:12.152Z
blocked_by:
  - "746193"
---

Every object in Winston has a prefixed id (docs/design.md §11 Identifiers, §14). The format is stored in the database and pasted around by agents, so it's a hard-to-change decision worth making now. **This ticket also sets up testing:** the id generator is the first real, pure logic, so `bun test` and its conventions arrive with it (the standalone test ticket `ac22b7` was folded in here).

Research:
- **Id formats:** nanoid, base62 random, ULID, and TypeID. Pick something URL- and shell-safe, reasonably short, with enough entropy, and ideally time-sortable, since lists are "newest first" and it helps index locality. Outcome: **TypeID** (lowercase prefix + UUIDv7 in base32, for example `usr_01h2xcejqtf2nbrexx3vqjhp41`), via `typeid-js`.
- **`bun test`:** file discovery, running from the root, and type-level assertions.

Deliver:
- `packages/shared` gets its `tsconfig.json` and `typecheck` script (its first code).
- `src/ids.ts`: `Id<Prefix>` (a branded type, so ids of different entities can't be mixed), `createId(prefix)` and `parseId(value, prefix)`. **No registry of prefixes yet.** Each entity registers its prefix in the ticket that creates it, and the `winston get` resolver registry comes with the CLI.
- A root `test` script (`bun test`) and a short `docs/testing.md` covering where tests live, how to run them, what to test, and type-level assertions.

Tests: the format and prefix, ids sorting by creation order, invalid prefixes rejected, `parseId` rejecting wrong prefixes, malformed suffixes and uppercase, and type-level tests (`@ts-expect-error`) proving `Id<"usr">` and plain strings aren't accepted as `Id<"run">`.
