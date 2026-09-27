---
id: "746193"
title: Configure strict TypeScript for the workspace
status: done
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.069Z
updated_at: 2026-09-27T16:21:43.527Z
blocked_by:
  - "0fa82e"
---

End-to-end type safety is an invariant (docs/design.md, Part 3 invariants and §7), so the TypeScript setup has to be strict from day one.

Research first: the current recommended `tsconfig` for Bun, the defaults and removals in recent TypeScript releases, which TypeScript version `typescript-eslint` supports (use that one), and the recommended monorepo approach: project references vs per-package configs.

Outcome of that research (recorded in docs/design.md §7):
- **TypeScript 6.0.3.** TypeScript 7 has no programmatic API yet, so `typescript-eslint` can't use it.
- **Per-package configs, no project references.** Project references need `composite` and `.d.ts` output, which Bun doesn't need.

Deliver:
- `typescript` and `@types/bun` as exact root dev dependencies.
- `tsconfig.base.json`: Bun's recommended options plus extra strictness, with comments explaining the groups. Only options that apply today: no JSX or DOM settings until a package needs them.
- A root `typecheck` script running every package's `typecheck` script.

No package has TypeScript yet, so the first package config arrives with the first real code (the test ticket). Verify here with a temporary package config and file, removed before committing:
- Each strict option fires on a deliberate error.
- Bun types resolve.
- The root script fails when a package fails.
