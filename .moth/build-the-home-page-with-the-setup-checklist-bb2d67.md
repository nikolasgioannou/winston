---
id: "bb2d67"
title: Build the home page with the setup checklist
status: done
priority: none
labels:
  - m3
  - web
created_at: 2026-09-27T05:34:40.732Z
updated_at: 2026-09-30T03:17:08.389Z
blocked_by:
  - "0a5f39"
  - "5e3c6d"
---

`/home` is Winston's status page, and it doubles as first-run setup: until everything is connected, it shows a checklist (docs/design.md §20):
1. **Your computer:** provisioning, ready, or failed with retry. `computerStatus` (`@winston/db/vms`) and `retryFailedVm` already exist; poll while it's `setting_up` (docs/design.md §17, Setting up a computer). It can also be `unreachable`.
2. **Connect Telegram:** the linking ticket fills this in. Leave a slot that shows "not linked" for now.
3. **Connect your first account:** links to `/accounts`, filled in by the connections ticket.

Once all three are done, the page becomes a calm status summary instead: computer healthy, Telegram linked, and any accounts needing attention (auth expiring or expired, which the token-lifecycle ticket feeds in).

Design the page so later tickets can add their pieces without rework. Treat the checklist items and attention items as components fed by one loader. Use `packages/ui` only. Add all states to the dev design view: fresh user, provisioning, provisioning failed, partially set up, fully set up, attention needed. Review how it reads on mobile.

## Outcome

- `/home` has one loader, `getHomeState`, returning a `HomeState` (first name, computer status, Telegram linked, accounts connected, attention items); the page (`src/pages/home-page.tsx`) is a pure function of it. Accounts are 0 and attention empty until their tickets fill them in; Telegram reads `telegram_links`.
- Setup checklist until the computer is ready, Telegram is linked and an account is connected: three numbered steps with markers, explanations and actions (Retry, a "Not linked" pill until the linking ticket, Connect to `/accounts`). Then a status summary: attention callouts and a Status card (computer, Telegram, accounts).
- The page re-runs its loader every 3 s while the computer is setting up; Retry calls the `retryComputer` server function. 0a5f39's `getComputerStatus` was folded into the loader.
- Dev design view states, rendered inside the app shell: fresh user (provisioning), provisioning failed, retrying, computer ready, partially set up, fully set up, attention needed, computer not responding. Checked at desktop and mobile widths; actions drop below the text on phones.
- Checked live: the seeded user's `/home` showed the real state; with the VM set to `failed`, Retry re-provisioned it and the page moved to ready on its own.

