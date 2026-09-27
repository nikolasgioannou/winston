# Testing

- **Runner:** `bun test`, run from the repo root with `bun run test`. It finds every `*.test.ts` file in the workspace.
- **Where tests live:** next to the code they test (`src/ids.ts` → `src/ids.test.ts`), so they're type-checked with the package.
- **What to test:** deterministic code, where subtle bugs hide. LLM judgment isn't unit-tested (see docs/design.md §8b).
- **Type-level behavior:** assert it with `// @ts-expect-error` in the test file. `typecheck` fails if the expected error disappears.
- **Expected rejections:** capture the error and assert on it, `const error = await promise.catch((e: unknown) => e); expect(error).toBeInstanceOf(Error);`. Bun's types declare `.rejects` matchers as returning `void`, so awaiting them trips the linter, and not awaiting them lets a test pass without checking anything.

## Database tests

Tests that touch Postgres use the helpers in `@winston/db/testing` against a separate `winston_test` database (`TEST_DATABASE_URL`). It's created and migrated automatically on the first test run. Postgres must be running (`./scripts/setup.sh` or `bun run db:up`). Without it, tests fail fast with a message saying so.

```ts
import { inRollback, insertUser, testDb } from "@winston/db/testing";

const db = await testDb();

test("…", async () => {
  await inRollback(db, async (tx) => {
    const user = await insertUser(tx, { email: "a@example.com" });
    // …queries on `tx`; everything is rolled back afterwards
  });
});
```

- **`inRollback`** is the default: the test runs in a transaction that's always rolled back, so tests can't see each other's rows.
- **`truncateAll`** is for tests that need real concurrent connections (for example two workers racing for a job), where one rollback transaction can't be shared. Call it at the start of each such test.
- **Factories** like `insertUser` fill in unique defaults. Add one when a new table needs test rows.
- **Don't assume a table is empty** unless the test just called `truncateAll`. Other tests may leave committed rows behind. Filter by something the test owns (a unique type, email or id) instead.
- `bun test` doesn't load `.env.local` by itself (test mode skips it), so the `test` script passes `--env-file=.env.local`. CI sets `TEST_DATABASE_URL` directly and runs Postgres as a service container.
