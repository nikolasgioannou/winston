---
id: "32ddbd"
title: There's nowhere to keep Winston's email address
status: done
priority: none
labels:
  - backend
  - db
parent: "ead827"
created_at: 2026-10-04T02:55:27.329Z
updated_at: 2026-10-04T03:17:58.189Z
---

Winston can't have an email address until there's somewhere to keep it: who owns which address, which one is current, and what happens when it changes or the account goes (ead827).

**What to build**

- The data: a mailbox per user (on or off) as a mail connection whose provider is our own (named in `@winston/domain/connections`, alongside Gmail), and its addresses (current, aliases, retired). An address is unique for good: nothing ever frees it.
- Name rules in `@winston/domain`: lowercase letters, digits, dots and hyphens, 3–30 characters, no leading, trailing or doubled dots; a reserved list (`admin`, `postmaster`, `abuse`, `support`, `noreply`, `winston`, …).
- Server functions the site will call: check a name's availability (with the reason when it isn't), turn on with a name, change the name (the old one stays as an alias; at most 2 changes in total, refused after with a reason), turn off and on again (same address and mailbox).
- Turning on and off records `system.app.connected` / `system.app.disconnected` like other connections, so Winston hears about it.
- The mailbox isn't listed under Connected accounts and has no capability switches; `resolveConnection` finds it by any of its addresses.
- Account deletion retires the user's addresses (kept, never released) instead of deleting them.
- `product.md` (drop "Winston's own email address" from out of scope; describe the feature) and `design.md` (§5 connections, §14 data model) updated.

**Done when**

- [x] Tests cover name rules, availability (taken, retired, alias, reserved), the change limit, turning off and on, and that a deleted account's addresses can't be taken again
- [x] `winston accounts list` shows Winston's mailbox, and `--account <any of its addresses>` resolves to it
- [x] `bun run check` passes

## As built

- **Data:** provider `winston` on `connections` (no token, `granted_at` = when it was turned on, every capability on), and `mailbox_addresses` (address as the key, deleted with the user like every `user_id` table). Account deletion first puts each address's SHA-256 hash in `retired_mailbox_addresses`, so none is ever given out again without keeping the address itself. Name rules and the reserved list in `@winston/domain/mailbox`; `checkMailboxName`, `mailboxState`, `turnOnMailbox`, `changeMailboxAddress` and `turnOffMailbox` in `@winston/db/mailbox`, ready for the site's server functions (31c4e8).
- **Guards:** `googleBacked` (`@winston/db/connections`) keeps the mailbox out of the grant sweep, reconciliation, watches and the site's accounts list, Home's count, toggles and disconnect; the sync and watch handlers skip it, and the Gmail webhook matches `gmail` only. `turnOffMailbox` shares `endConnection` with disconnecting (subscriptions end, `system.app.disconnected`) but queues no revoke.
- **CLI:** `winston accounts list` shows it (provider "Winston's own"), with notes and no reconnect links. Mail calls on it fail as `not_supported` until 44bcf2 and 201a9b.

**Decided while building:**
- **Without `--account`, mail commands mean the user's accounts, never Winston's**, so turning his mailbox on doesn't make "search my mail" ambiguous for a user with one Gmail. With only his mailbox, the error names it.
- **An address change is `system.settings.changed`** (`field: mailbox_address`) rather than a new connection event, since it's the same mailbox.
- **Going back to an old address counts as a change**, so the limit can't be dodged.
- **Retired addresses are kept as hashes**, not as rows that outlive their user: the deletion test requires every `user_id` to cascade, and the site promises deletion removes everything.
- **One mailbox per user** is a lock on the user's row: Postgres can't use the new enum value in the migration's own transaction, so a partial unique index on `provider = 'winston'` wasn't possible.

`product.md` (identity, channels, out of scope) and `design.md` (§5 Connections, §14) updated.
