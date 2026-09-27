---
id: "5e3c6d"
title: Build the app shell with sidebar navigation
status: todo
priority: none
labels:
  - m3
  - ui
  - web
created_at: 2026-09-27T05:34:40.572Z
updated_at: 2026-09-27T05:34:40.604Z
blocked_by:
  - "7b6af9"
---

Everything behind sign-in shares one app shell with a sidebar, grouped by purpose, and no catch-all settings page (docs/design.md §20):
- **Home**
- **Connections:** Accounts, Telegram
- **You:** Profile, Delete account

On mobile the sidebar collapses into a drawer.

Build with `packages/ui` primitives, adding to the design system where needed:
- A layout route that requires a session (redirect to `/signin` otherwise) and renders the sidebar and content area.
- Signed-in visitors to `/` are redirected to `/home`.
- Active-route highlighting, keyboard accessibility, and a drawer on mobile that traps focus while open and closes on navigation.
- The user's name and a sign-out action somewhere sensible (probably the bottom of the sidebar).
- Placeholder content for routes that don't exist yet, so navigation works end to end.

Add the shell's states to the dev design view: desktop, mobile closed, mobile drawer open, long names. Check it on a real phone-sized viewport.
