---
id: "7b6af9"
title: Build the dev design view with the founder
status: todo
priority: none
labels:
  - collab
  - m3
  - ui
  - web
created_at: 2026-09-27T05:34:40.523Z
updated_at: 2026-09-27T05:34:40.556Z
blocked_by:
  - "244f55"
---

The web app will have many states: provisioning, auth expiring, disconnected, errors, empty lists, mobile vs desktop. The founder wants one place to see **every page in every state, at desktop and mobile widths**, side by side (docs/design.md §20). Build it with them: agree on the layout of the view itself, review it together, iterate.

`/dev/design` is **dev only**. It must be excluded from production builds, not just hidden. Research how to do that cleanly with TanStack Start's routing and build (for example an env-gated route tree, or a separate dev entry).

How it should work:
- Each page exposes its states as data-driven fixtures: the page component rendered with mocked loader data, no network. Establish this pattern with `/signin`'s states now. Every later page ticket adds its own states here.
- Each state renders in frames at a desktop width and a mobile width (real iframes or container queries, whichever faithfully triggers responsive behaviour). Research which is more faithful.
- A way to jump to a page or state quickly, and a section showing the `packages/ui` components themselves.

Done when the founder can open `/dev/design`, see `/signin` in all its states on both widths, and is happy with how the view works. From here, every page ticket includes "add this page's states to the dev design view."
