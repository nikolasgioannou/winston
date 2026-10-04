---
id: "32ddbd"
title: There's nowhere to keep Winston's email address
status: todo
priority: none
labels:
  - backend
  - db
parent: "ead827"
created_at: 2026-10-04T02:55:27.329Z
updated_at: 2026-10-04T02:55:34.491Z
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

- [ ] Tests cover name rules, availability (taken, retired, alias, reserved), the change limit, turning off and on, and that a deleted account's addresses can't be taken again
- [ ] `winston accounts list` shows Winston's mailbox, and `--account <any of its addresses>` resolves to it
- [ ] `bun run check` passes
