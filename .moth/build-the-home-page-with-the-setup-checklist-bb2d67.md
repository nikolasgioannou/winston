---
id: "bb2d67"
title: Build the home page with the setup checklist
status: todo
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:40.732Z
updated_at: 2026-09-27T05:34:40.780Z
blocked_by:
  - "0a5f39"
  - "5e3c6d"
---

`/home` is Winston's status page, and it doubles as first-run setup: until everything is connected, it shows a checklist (docs/design.md §20):
1. **Your computer:** provisioning, ready, or failed with retry. `getComputerStatus` and `retryComputer` (`apps/web/src/server/computer-functions.ts`) already exist; poll the status every few seconds while it's `setting_up` (docs/design.md §17, Setting up a computer). It can also be `unreachable`.
2. **Connect Telegram:** the linking ticket fills this in. Leave a slot that shows "not linked" for now.
3. **Connect your first account:** links to `/accounts`, filled in by the connections ticket.

Once all three are done, the page becomes a calm status summary instead: computer healthy, Telegram linked, and any accounts needing attention (auth expiring or expired, which the token-lifecycle ticket feeds in).

Design the page so later tickets can add their pieces without rework. Treat the checklist items and attention items as components fed by one loader. Use `packages/ui` only. Add all states to the dev design view: fresh user, provisioning, provisioning failed, partially set up, fully set up, attention needed. Review how it reads on mobile.
