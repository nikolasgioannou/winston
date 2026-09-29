---
id: "5e3c6d"
title: Build the app shell with sidebar navigation
status: done
priority: none
labels:
  - m3
  - ui
  - web
created_at: 2026-09-27T05:34:40.572Z
updated_at: 2026-09-29T04:28:55.780Z
blocked_by:
  - "7b6af9"
---

Everything behind sign-in shares one app shell with a sidebar, grouped by purpose, and no catch-all settings page (docs/design.md §20):
- **Home**, **Connected accounts**, **Profile**: a flat list for now. Profile holds the Telegram link, sign-out and account deletion.

(Revised with the founder in review; originally grouped as Home; Connections: Accounts, Telegram; You: Profile, Delete account.)

On mobile the sidebar collapses into a drawer.

Build with `packages/ui` primitives, adding to the design system where needed:
- A layout route that requires a session (redirect to `/signin` otherwise) and renders the sidebar and content area.
- Signed-in visitors to `/` are redirected to `/home`.
- Active-route highlighting, keyboard accessibility, and a drawer on mobile that traps focus while open and closes on navigation.
- The user's name and a sign-out action somewhere sensible (probably the bottom of the sidebar).
- Placeholder content for routes that don't exist yet, so navigation works end to end.

Add the shell's states to the dev design view: desktop, mobile closed, mobile drawer open, long names. Check it on a real phone-sized viewport.

Persist the sidebar's width (the `Sidebar` component's `defaultWidth` and `onWidthChange` from `packages/ui`) in a cookie, not local storage, so the server renders the saved width and the sidebar doesn't jump after the page loads. Same approach as the light/dark theme choice.

## Outcome

- `AppShell` (`apps/web/src/components/app-shell.tsx`) in the `_authed` layout: `Sidebar` from 640px up, and below that a top bar with `SidebarDrawer` (Base UI's drawer is modal by default: focus trapped, scroll locked). Items, a flat list with no section headers (the founder's call): Home, Connected accounts (address `/accounts`, a blocks icon since it covers every kind of account (chosen from a side-by-side comparison)) and Profile. Telegram, sign-out and delete account belong on Profile; the Telegram-linking, profile and deletion tickets were updated, and the `/telegram` and `/profile/delete` routes dropped. Links highlight the longest matching item. The drawer is open only on the page it was opened on, so navigating closes it (without an effect, per the React Compiler lint).
- Founder review: nothing pinned to the bottom of the sidebar. Sign-out and delete account belong on `/profile` (its placeholder has a working Sign out; the profile and deletion tickets were updated), so there's no Delete account item or `/profile/delete` route, and the sidebar footer slot was dropped.
- `/` redirects signed-in visitors to `/home`; placeholder pages for Home, Connected accounts and Profile.
- Sidebar width in the `winston_sidebar_width` cookie (written on resize end, read by `getShellState` in `beforeLoad`), so the server renders it.
- Dev design view: "App shell" states default and drawer open. Checked at 1512px (sidebar, current item) and 375px (menu button, drawer with the same links).
