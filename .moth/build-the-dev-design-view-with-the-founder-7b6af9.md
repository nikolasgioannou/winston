---
id: "7b6af9"
title: Build the dev design view with the founder
status: done
priority: none
labels:
  - collab
  - m3
  - ui
  - web
created_at: 2026-09-27T05:34:40.523Z
updated_at: 2026-09-29T03:38:08.272Z
blocked_by:
  - "244f55"
---

The web app will have many states: provisioning, auth expiring, disconnected, errors, empty lists, mobile vs desktop. The founder wants one place to see **every page in every state, at desktop and mobile widths**, side by side (docs/design.md §20). Build it with them: agree on the layout of the view itself, review it together, iterate.

`/dev/design` is **dev only**. It must be excluded from production builds, not just hidden. Research how to do that cleanly with TanStack Start's routing and build (for example an env-gated route tree, or a separate dev entry).

How it should work:
- Each page exposes its states as data-driven fixtures: the page component rendered with mocked loader data, no network. Establish this pattern with `/signin`'s states now. Every later page ticket adds its own states here.
- Each state renders in a frame at a desktop width or a mobile width. Iframes, not container queries: components respond to the viewport (Tailwind's breakpoints are media queries, and dialogs, toasts and the drawer position against it), and only an iframe gives the page a real viewport.
- Layout, agreed with the founder on 2026-09-28: our `Sidebar` lists the pages; for the selected page, a select picks the state and another picks the frame (desktop or mobile); a light/dark toggle applies to everything. No section for the `packages/ui` components themselves (the founder's call).

Done when the founder can open `/dev/design`, see `/signin` in all its states on both widths, and is happy with how the view works. From here, every page ticket includes "add this page's states to the dev design view."

## Outcome

- `/dev/design` as agreed with the founder: `Sidebar` of pages, a state select, a frame select (desktop 1280×800 scaled to fit, mobile 375×812, square corners), a theme select (light or dark) for the view and the frame; the choices live in the URL. No component section.
- Frames are iframes of `/dev/design/frame`, so each state gets a real viewport.
- Fixtures pattern: `PageFixtures`, `sign-in-page.fixtures.tsx` with /signin's four states, and the page list in `src/routes/dev/-pages.ts`.
- Excluded from production builds: build-only `routeFileIgnorePattern: "^dev$"` with a separate gitignored `routeTree.prod.gen.ts` and an alias, so the committed route tree never changes. `verify:build`, run by `bun run check`, fails if the output contains `/dev/design` or fixtures, or if the build rewrote the committed tree.
- Checked in the browser: every state, both frames (the mobile frame's viewport is really 375px), light and dark.

