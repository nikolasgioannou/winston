import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { withTestPostgres } from "../../src/postgres";

test("disposable PostgreSQL rolls back transactions and isolates each run", async () => {
  await assert.rejects(
    withTestPostgres(async (sql) => {
      const databases = await sql<{ name: string }[]>`SELECT current_database() AS name`;

      expect(databases[0]?.name).toBe("winston_test");

      await sql`CREATE TABLE synthetic_events (id integer PRIMARY KEY)`;
      await assert.rejects(
        sql.begin(async (transaction) => {
          await transaction`INSERT INTO synthetic_events VALUES (1)`;

          throw new Error("injected transaction failure");
        }),
        /injected transaction failure/,
      );

      const rows = await sql<{ id: number }[]>`SELECT id FROM synthetic_events`;

      expect(rows).toHaveLength(0);

      throw new Error("injected callback failure");
    }),
    /injected callback failure/,
  );

  await withTestPostgres(async (sql) => {
    const tables = await sql<{ name: string | null }[]>`
      SELECT to_regclass('public.synthetic_events')::text AS name
    `;

    expect(tables[0]?.name).toBeNull();
  });
});
