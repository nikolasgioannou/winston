---
id: "6b393b"
title: Scaffold the web app with TanStack Start, Tailwind and its lint setup
status: done
priority: none
labels:
  - m3
  - tooling
  - web
created_at: 2026-09-27T05:34:40.281Z
updated_at: 2026-09-29T00:40:46.236Z
blocked_by:
  - "51d785"
  - "6bac51"
---

`apps/web` is a TanStack Start app on Bun, styled with Tailwind, and it adds several new tools to the repo (docs/design.md §9 Website, §8b Tooling). This ticket is mostly careful setup, so do **thorough research** on each tool and how they fit together before writing config:
- **TanStack Start:** project structure, file-based routing with TanStack Router, server functions (`createServerFn`) and input validators, loaders, SSR vs SPA modes, and deploying on Bun via the Nitro `bun` preset (React 19 required). Check the current release status, since the docs described it as a release candidate when the design was written.
- **Tailwind CSS v4:** the CSS-first config (`@theme`), the Vite plugin, and how it will consume tokens from `packages/ui`.
- **Prettier's `prettier-plugin-tailwindcss`:** class **ordering**. Understand its interaction with other Prettier plugins, and where it must sit in the plugin list.
- **ESLint for the web app:** `eslint-plugin-react-hooks`, TanStack's ESLint plugins (Router/Query), and `eslint-plugin-better-tailwindcss` with the rules from §8b enabled (shorthand, canonical, duplicate, deprecated, conflicting, unknown, concatenated classes) and its class-order rule **off**, because Prettier owns ordering. Scope these to `apps/web` and `packages/ui` in the flat config.

Deliver a running app with one placeholder route. Add `web` to `bun dev`. Confirm lint catches, for example, `mx-2 my-2` and `p-2 p-4`, and that Prettier sorts classes, so the pre-commit hook enforces all of it.

No real pages yet. The design system comes first, in the next ticket.

## Outcome

- `apps/web` (`@winston/web`): TanStack Start 1.168 / Router 1.170 (stable), React 19.3, Vite 8, Tailwind 4.3 via `@tailwindcss/vite`, all pinned; hand-written files (`vite.config.ts` on port 3002, `router.tsx`, `routes/__root.tsx`, a placeholder `routes/index.tsx`, `styles/app.css`); `routeTree.gen.ts` committed. `verbatimModuleSyntax` is off for the site, per Start's docs. `vite build` works; the production server (Nitro v3 is still beta vs a `Bun.serve` script) is decided with the containers in M4.
- `bun dev` runs the site as `web`.
- Prettier: `prettier-plugin-tailwindcss` last, with `tailwindStylesheet` and `cn`/`clsx`/`cva`. ESLint: TSX included; for `apps/web`, react-hooks `recommended`, TanStack Router `flat/recommended`, better-tailwindcss `recommended-error` plus `enforce-shorthand-classes`, with class order, line wrapping and whitespace off. `packages/ui`'s block comes with the design system.
- Checked: `mx-2 my-2`, `p-2 p-4` and an unknown class fail lint; Prettier sorted `text-sm flex p-2 bg-red-500` to `flex bg-red-500 p-2 text-sm`; the page renders server-side with Tailwind's classes compiled.
