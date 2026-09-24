import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("workspace catalog pages owner metadata without exposing execution authority", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const ids = Array.from({ length: 101 }, () => randomUUID()).sort();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      await database.transaction(ownerId, async ({ workspaces }) => {
        for (const id of ids) await workspaces.register(id, "Fixture");
      });
      await database.transaction(other, ({ workspaces }) =>
        workspaces.register(randomUUID(), "Other owner"),
      );
      const first = await database.transaction(ownerId, ({ workspaces }) => workspaces.list());
      assert.equal(first.items.length, 100);
      assert.equal(first.next, ids[99]);
      assert.deepEqual(Object.keys(first.items[0] ?? {}).sort(), [
        "id",
        "name",
        "revision",
        "state",
      ]);
      assert.ok(first.next);
      const second = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.list(first.next ?? undefined),
      );
      assert.equal(second.next, null);
      assert.deepEqual(
        [...first.items, ...second.items].map((item) => item.id),
        ids,
      );
      assert.equal(
        (await database.transaction(other, ({ workspaces }) => workspaces.list())).items.length,
        1,
      );
    } finally {
      await database.close();
    }
  });
});
