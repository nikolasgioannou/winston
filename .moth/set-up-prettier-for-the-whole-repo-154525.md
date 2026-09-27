---
id: "154525"
title: Set up Prettier for the whole repo
status: todo
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.117Z
updated_at: 2026-09-27T05:28:45.147Z
blocked_by:
  - "0fa82e"
---

Formatting is owned by Prettier (docs/design.md §8b). ESLint will handle correctness in the next ticket, and the two must not overlap.

Research before configuring: current Prettier config options and defaults, how `.prettierignore` interacts with `.gitignore`, how Prettier handles Markdown (the docs and `.moth/` tickets are Markdown, and reflowing them would create noisy diffs), YAML, JSON and TOML. Look at how `prettier-plugin-tailwindcss` will be added later in the web ticket, so the config file format chosen now (for example `prettier.config.js` vs `.prettierrc`) accommodates plugins cleanly. Look at `eslint-config-prettier` too, even though ESLint comes next, because it decides which ESLint rules must be switched off.

Decide and document the style (print width, quotes, semicolons, trailing commas) in a comment at the top of the config, add a `.prettierignore` (lockfiles, build output, generated migrations if any), and add `format` (write) and `format:check` scripts at the root. Decide deliberately whether Prettier formats `docs/` and `.moth/`. Leaning towards `proseWrap: "preserve"` so Markdown content isn't rewrapped.

Run it across the repo once and commit the result, so later diffs only contain real changes.
