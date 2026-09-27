---
id: "991c7d"
title: Set up ESLint with type-aware typescript-eslint rules
status: todo
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.162Z
updated_at: 2026-09-27T05:28:45.209Z
blocked_by:
  - "154525"
  - "746193"
---

ESLint is the correctness linter (docs/design.md §8b). It was chosen over Biome for its plugin ecosystem, because React hooks, TanStack and Tailwind plugins arrive in later tickets.

Do thorough research before writing config: ESLint's flat config (`eslint.config.js`), `typescript-eslint`'s type-checked presets (`strictTypeChecked`, `stylisticTypeChecked`) and `projectService` for monorepos, performance implications of type-aware linting (it matters because lefthook will lint staged files on every commit), and how `eslint-config-prettier` turns off rules that conflict with Prettier. Understand how per-package overrides will work once `apps/web` adds React-specific plugins, and structure the config so those drop in without rewriting it.

Rules that matter for this codebase:
- `@typescript-eslint/no-explicit-any` as an error. No `any` is part of the type-safety invariant.
- `no-floating-promises` and `no-misused-promises`. The agent loop and job workers are async-heavy, and a dropped promise there is a silent bug.
- `switch-exhaustiveness-check`, because the state machines in §17 are unions.

Add a root `lint` script (and `lint:fix`). The skeleton must lint clean. Add a deliberately bad file locally to confirm each of the rules above fires, then delete it.
