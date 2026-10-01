---
id: "bf0135"
title: Move page layout into the design system
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T00:11:34.097Z
updated_at: 2026-10-01T00:13:50.841Z
blocked_by:
  - "75bfa7"
---

Every page hand-writes the same structure: the centred column (`mx-auto max-w-3xl px-6 py-8 sm:px-10`, with gaps that already drift between 8 and 10), the title (`text-title font-semibold`), and bits like the small icon tile on account rows. The founder wants the design system used everywhere, so pages build on shared pieces.

- Add `Page` (the column and its spacing) and `PageHeader` (title, optional back link, optional action such as Add account) to `packages/ui`, plus an `IconTile` for the small square that holds an icon.
- Use them on every signed-in page (Home, Connected accounts, the account page, Profile) and the placeholder page; the dev design view shows them through those pages.
- Record them in design.md's design system notes.

## Outcome

- `Page`, `PageHeader` (title, optional back link as a small ghost button around the app's `Link`, optional action) and `IconTile` in `packages/ui`.
- Home, Connected accounts, the account page, Profile and the placeholder page use them; every page now has the same 32px rhythm (they had drifted between 32 and 40). Only the sign-in page keeps its own heading, since it's a centred card rather than a signed-in page.
- The account page's provider moved into a badge beside the address (it goes away with the dialog in 8fffdd).
- design.md: the components list is brought up to date (it missed `LinkCard`, `Menu`, `SearchSelect`, `QrCode` and `ConfirmDialog`'s `confirmText`), and a Page layout note records the rule that pages build only on `packages/ui`.

