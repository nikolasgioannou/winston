---
id: "801d97"
title: Build the design system foundations with the founder
status: done
priority: none
labels:
  - collab
  - m3
  - ui
  - web
created_at: 2026-09-27T05:34:40.345Z
updated_at: 2026-09-29T02:37:44.200Z
blocked_by:
  - "6b393b"
---

The founder considers the design system really important, and wants this ticket to be **built together**: propose, show, get feedback, iterate. Don't finish it in one pass alone. Plan for several review rounds, and keep asking for direction on look and feel.

`packages/ui` is the only source of UI for the web app. The app consumes its components and tokens, never ad-hoc styles (docs/design.md §9, §21). It's built on **Base UI** primitives with **Tailwind**.

Research first:
- Base UI's current component set and API (unstyled, accessible primitives), how it's styled with Tailwind, and how its accessibility behaviour works.
- How Tailwind v4 theme tokens (`@theme`) can be defined in `packages/ui` and shared with `apps/web`.
- Dark mode strategy.

Bring findings and **a couple of visual directions** to the founder before building much.

Foundations to establish, in collaboration:
- **Tokens:** color (including semantic colors for status: ok, attention, error, pending), typography scale, spacing, radius, shadows, motion.
- **Core components** the planned pages need: button, input, switch or toggle (capability toggles are central), select, dialog (delete confirmations), toast or inline feedback, card/section, badge/status pill, sidebar and nav primitives, empty and error states, loading skeletons.
- Mobile-first behaviour for everything, since the handoff page and drawer navigation are used on phones.

Done when the founder is happy with the direction and the core set exists. The dev design view (a later ticket) is where they'll keep reviewing it in context.

## Outcome

- Direction: Notion's visual language, chosen by the founder; values captured from app.notion.com (CSS variables for both themes, plus sizes, radii, shadows and timings from real elements). Departures agreed in review: one control size scale (`sm` 28, `md` 32) for buttons, selects and text fields, all with 14px text; a Linear-style select that opens over its trigger and closes instantly; a dark-mode red that reads as active; a solid 2px sidebar resize line measured from Notion.
- `packages/ui`: tokens (`light-dark()` colors, system theme with a `data-theme` override) and the core set: `Button`, `Select`, `TextField`, `Switch`, `StatusPill`, `Section` (optionally carded) and `SettingRow`, `Card`, `ConfirmDialog`, a resizable `Sidebar` (270px default and minimum, max provisional) with Lucide icons and `SidebarDrawer` for small screens, `Toaster`/`toast()` (Sonner, themed with our tokens, after Base UI's toast overlapped when one replaced another) and `Callout`, `EmptyState`/`ErrorState`, and `Skeleton`. Everything works on phone widths.
- Fixed along the way: `tailwind-merge` dropping the custom text sizes, the lint not checking pixel values against the spacing scale (`rootFontSize`), and a stylesheet comment that confused the Tailwind editor extension.
- Reviewed by the founder in a temporary preview page that isn't committed; the dev design view ticket builds the real `/dev/design`, including a components section. Sidebar width persistence went to the app-shell ticket. Open: a light/dark/system picker, or system only.
