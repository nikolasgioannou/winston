# Testing

- **Runner:** `bun test`, run from the repo root with `bun run test`. It finds every `*.test.ts` file in the workspace.
- **Where tests live:** next to the code they test (`src/ids.ts` → `src/ids.test.ts`), so they're type-checked with the package.
- **What to test:** deterministic code, where subtle bugs hide. LLM judgment isn't unit-tested (see docs/design.md §8b).
- **Type-level behavior:** assert it with `// @ts-expect-error` in the test file. `typecheck` fails if the expected error disappears.
