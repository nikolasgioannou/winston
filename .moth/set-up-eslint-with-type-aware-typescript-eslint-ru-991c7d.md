---
id: "991c7d"
title: Set up ESLint with type-aware typescript-eslint rules
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.162Z
updated_at: 2026-09-27T16:37:29.652Z
blocked_by:
  - "154525"
  - "746193"
---

ESLint is the correctness linter (docs/design.md §8b). It was chosen over Biome for its plugin ecosystem, since React hooks, TanStack and Tailwind plugins arrive in later tickets.

Research before writing config: ESLint's flat config and TypeScript config files, `typescript-eslint`'s type-checked presets and `projectService`, how files outside any tsconfig are handled, the performance of type-aware linting (lefthook will lint staged files on every commit), and how `eslint-config-prettier` turns off rules that overlap with Prettier. The config should be structured so later per-area config objects (React/TanStack for `apps/web`, Tailwind) can be appended without rewriting it, but don't add those plugins now.

Decisions made:
- ESLint 10 with `eslint.config.ts`, loaded through `jiti`.
- `@eslint/js` recommended + `strictTypeChecked` + `stylisticTypeChecked`. `typescript-eslint` is pinned exactly, because its strict preset isn't semver-stable. `switch-exhaustiveness-check` is left out until the first switch over a union exists.
- `projectService` with `tsconfigRootDir`. A root `tsconfig.json` covers the repo-root `.ts` config files, so they're type-checked (the root `typecheck` script now runs `tsc` first) and linted with types, with no `allowDefaultProject` workaround.
- `eslint-config-prettier/flat` last.
- `lint` and `lint:fix` scripts with `--max-warnings 0`.

The rules that matter most for this codebase, all confirmed firing on a deliberately bad file (deleted afterwards): `no-explicit-any`, `no-floating-promises` and `no-misused-promises`. The repo lints clean. `eslint-config-prettier`'s checker reports no conflicts.
