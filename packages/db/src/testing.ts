/**
 * Helpers for tests that need a real Postgres. See docs/testing.md.
 */
import { loadConfig } from "@winston/shared/config";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { z } from "zod";
import { createDb, type Db, type DbOrTx } from "./client.ts";
import { assertLocalDatabase } from "./config.ts";
import { runs, users } from "./schema/index.ts";

const testConfigSchema = z.object({
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

let ready: Promise<Db> | undefined;

/**
 * The test database, created and migrated once per test run. Fails fast with a
 * clear message when Postgres isn't running.
 */
export function testDb(): Promise<Db> {
  return (ready ??= prepareTestDb());
}

async function prepareTestDb() {
  const { TEST_DATABASE_URL: url } = loadConfig(testConfigSchema);
  assertLocalDatabase(url, "run tests against");
  const name = new URL(url).pathname.slice(1);
  const server = new URL(url);
  server.pathname = "/postgres";

  const admin = postgres(server.href, {
    max: 1,
    connect_timeout: 3,
    onnotice: () => undefined,
  });
  try {
    const existing =
      await admin`select 1 from pg_database where datname = ${name}`;
    if (existing.length === 0) await admin.unsafe(`create database "${name}"`);
  } catch (error) {
    throw new Error(
      `Can't reach Postgres at ${server.host} for tests. Start it with ./scripts/setup.sh (or bun run db:up).`,
      { cause: error },
    );
  } finally {
    await admin.end();
  }

  const db = createDb(url);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  return db;
}

/**
 * Runs `test` inside a transaction that is always rolled back, so nothing it
 * writes is visible to other tests. The default way to isolate a DB test.
 */
export async function inRollback(db: Db, test: (tx: DbOrTx) => Promise<void>) {
  try {
    await db.transaction(async (tx) => {
      await test(tx);
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) throw error;
  }
}

/**
 * Empties every table. For tests that need real concurrent connections, where
 * a rollback transaction can't be shared; call it before each such test.
 */
export async function truncateAll(db: Db) {
  const tables = await db.$client<{ name: string }[]>`
    select quote_ident(tablename) as name from pg_tables where schemaname = 'public'`;
  if (tables.length > 0) {
    await db.$client.unsafe(
      `truncate ${tables.map((t) => t.name).join(", ")} restart identity cascade`,
    );
  }
}

let userCount = 0;

/** Inserts a user with unique defaults; pass fields to override. */
export async function insertUser(
  db: DbOrTx,
  overrides: Partial<typeof users.$inferInsert> = {},
) {
  userCount += 1;
  const [user] = await db
    .insert(users)
    .values({
      email: `user${userCount.toString()}@example.com`,
      firstName: "Test",
      lastName: `User ${userCount.toString()}`,
      timezone: "America/New_York",
      ...overrides,
    })
    .returning();
  if (!user) throw new Error("Inserting a test user returned no row.");
  return user;
}

/** Inserts a run for `userId`; pass fields to override. */
export async function insertRun(
  db: DbOrTx,
  userId: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
) {
  const [run] = await db
    .insert(runs)
    .values({ userId, ...overrides })
    .returning();
  if (!run) throw new Error("Inserting a test run returned no row.");
  return run;
}
