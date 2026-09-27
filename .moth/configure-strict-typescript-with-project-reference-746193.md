---
id: "746193"
title: Configure strict TypeScript with project references
status: todo
priority: none
labels:
  - m0
  - tooling
created_at: 2026-09-27T05:28:45.069Z
updated_at: 2026-09-27T05:28:45.101Z
blocked_by:
  - "0fa82e"
---

End-to-end type safety is an invariant (docs/design.md, Part 3 invariants and §7), so the TypeScript setup has to be strict from day one and fast enough to run in a pre-commit hook.

Research first: the current recommended `tsconfig` for a Bun + ESM monorepo (`module`/`moduleResolution` choices such as `bundler` vs `nodenext`, `verbatimModuleSyntax`, `isolatedModules`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), how project references and `tsc -b` give incremental checks across workspaces, and how `@types/bun` should be wired in. Also note which settings TanStack Start, Drizzle, Hono and the AI SDK expect, so later tickets don't need to loosen anything. Record the reasoning for non-obvious flags as comments in the base config.

Deliver:
- `tsconfig.base.json` with the strict settings. Every package extends it.
- A root `tsconfig.json` that references each workspace package, so `tsc -b` checks the whole repo incrementally.
- A root `typecheck` script (`tsc -b`, no emit of runtime code).
- Cross-package imports that work in both editor and `tsc` (for example `@winston/shared` imported from `apps/api`). Prove it with one real import.

Acceptance: `bun run typecheck` passes on the skeleton. Introducing an obvious type error in any package makes it fail. A second run with no changes is noticeably faster than the first, showing incremental builds work.
