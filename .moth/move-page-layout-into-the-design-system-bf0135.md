---
id: "bf0135"
title: Move page layout into the design system
status: backlog
priority: none
labels:
  - m3
  - web
created_at: 2026-10-01T00:11:34.097Z
updated_at: 2026-10-01T00:11:34.177Z
blocked_by:
  - "75bfa7"
---

Every page hand-writes the same structure: the centred column (`mx-auto max-w-3xl px-6 py-8 sm:px-10`, with gaps that already drift between 8 and 10), the title (`text-title font-semibold`), and bits like the small icon tile on account rows. The founder wants the design system used everywhere, so pages build on shared pieces.

- Add `Page` (the column and its spacing) and `PageHeader` (title, optional back link, optional action such as Add account) to `packages/ui`, plus an `IconTile` for the small square that holds an icon.
- Use them on every signed-in page (Home, Connected accounts, the account page, Profile) and the placeholder page; the dev design view shows them through those pages.
- Record them in design.md's design system notes.
