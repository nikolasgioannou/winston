import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("migrations serialize, preserve unrelated data, and detect incompatible history", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const database = createDatabase({ connectionString, onConnectionError: () => {} });

    try {
      await assert.rejects(database.assertCompatible(), /incompatible/);
      await sql`CREATE TABLE unrelated (value text)`;
      await sql`INSERT INTO unrelated VALUES ('preserved')`;
      await Promise.all([migrateDatabase(connectionString), migrateDatabase(connectionString)]);
      await database.assertCompatible();
      const rows = await sql<{ value: string }[]>`SELECT value FROM unrelated`;

      assert.equal(rows[0]?.value, "preserved");
      await sql`UPDATE winston_migrations.__drizzle_migrations SET hash = 'tampered' WHERE id = 1`;
      await assert.rejects(database.assertCompatible(), /immutable/);
      await assert.rejects(migrateDatabase(connectionString), /immutable/);
    } finally {
      await database.close();
    }
  });
});

test("an earlier migration fixture upgrades without resetting existing data", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const initial = await readFile(
      new URL("../../../adapters/migrations/0000_namespace.sql", import.meta.url),
      "utf8",
    );
    const hash = createHash("sha256").update(initial).digest("hex");

    await sql.unsafe(initial);
    await sql`CREATE SCHEMA winston_migrations`;
    await sql`CREATE TABLE winston_migrations.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`;
    await sql`INSERT INTO winston_migrations.__drizzle_migrations (hash, created_at) VALUES (${hash}, 1790000000000)`;
    await sql`CREATE TABLE winston.unrelated (value integer)`;
    await sql`INSERT INTO winston.unrelated VALUES (42)`;
    await migrateDatabase(connectionString);
    const rows = await sql<{ value: number }[]>`SELECT value FROM winston.unrelated`;

    assert.equal(rows[0]?.value, 42);
  });
});

test("owner repositories isolate owners and roll back a failed transaction", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const first = randomUUID();
    const second = randomUUID();

    try {
      await assert.rejects(
        database.transaction("", async () => {}),
        /owner ID/,
      );
      await assert.rejects(
        database.transaction(first, async ({ owners }) => {
          await owners.ensure();
          throw new Error("injected failure");
        }),
        /injected failure/,
      );
      assert.equal(await database.transaction(first, ({ owners }) => owners.find()), undefined);
      const owner = await database.transaction(first, ({ owners }) => owners.ensure());

      assert.equal(owner.id, first);
      assert.equal(await database.transaction(second, ({ owners }) => owners.find()), undefined);
      assert.equal((await database.transaction(first, ({ owners }) => owners.find()))?.id, first);
    } finally {
      await database.close();
    }
  });
});

test("a killed idle application connection is discarded and the next transaction reconnects", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const lost = Promise.withResolvers<boolean>();
    const database = createDatabase({
      connectionString,
      onConnectionError: () => {
        lost.resolve(true);
      },
    });
    const owner = randomUUID();

    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'winston' AND state = 'idle'`;
      await lost.promise;

      assert.equal((await database.transaction(owner, ({ owners }) => owners.find()))?.id, owner);
    } finally {
      await database.close();
    }
  });
});
