---
id: "154525"
title: Set up Prettier for the whole repo
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.117Z
updated_at: 2026-09-27T16:27:48.014Z
blocked_by:
  - "0fa82e"
---

Formatting is owned by Prettier (docs/design.md §8b). ESLint handles correctness in the next ticket, and the two must not overlap.

Research before configuring: the current Prettier version and config file formats, how `.prettierignore` and `.gitignore` interact, how Prettier treats Markdown (docs and `.moth/` tickets), and how plugins are wired in, including plugin ordering once `prettier-plugin-tailwindcss` joins in the web ticket.

Also add **`sort-package-json`**, via its Prettier integration **`prettier-plugin-packagejson`**, so `package.json` files are sorted whenever Prettier formats them. There's no separate command or hook.

Decisions made:
- Prettier's default style, so there's nothing to configure beyond plugins.
- A typed `prettier.config.ts`.
- Format `docs/` too (Markdown keeps its prose wrapping by default).
- Ignore `.moth/`, because Moth writes those files, and reformatting them would fight its output.

Add root `format` and `format:check` scripts. Run the formatter across the repo once, so later diffs only contain real changes. Verify that `format:check` passes, and that a `package.json` with shuffled keys comes out sorted.
