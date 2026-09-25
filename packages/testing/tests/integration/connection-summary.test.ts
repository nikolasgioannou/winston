import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("conversation connection summaries are fresh, bounded, owner-scoped and omit provider data", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const read = () =>
      database.transaction(ownerId, ({ connections }) => connections.conversationSummary());
    async function add(
      owner: string,
      service: Connection["service"],
      status: Connection["status"],
      subject: string,
    ) {
      const connection: Connection = {
        id: randomUUID(),
        service,
        status,
        subject,
        email: `${subject}@example.com`,
        revision: 0,
        scopes: ["private-scope-canary"],
        calendars: ["private-calendar-canary"],
      };
      await sql`
        INSERT INTO winston.credentials (owner_id, id, provider, revision, encrypted)
        VALUES (${owner}::uuid, ${connection.id}::uuid, 'google', 0, NULL)
      `;
      await sql`
        INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${owner}::uuid, ${connection.id}::uuid, ${subject}, ${service}, ${JSON.stringify(connection)}::text::jsonb)
      `;
      return connection;
    }
    try {
      for (const owner of [ownerId, stranger])
        await database.transaction(owner, ({ owners }) => owners.ensure());
      await add(stranger, "gmail", "connected", "stranger-canary");
      assert.deepEqual(await read(), { accounts: [], truncated: false });

      const gmail = await add(ownerId, "gmail", "connected", "personal");
      const calendar = await add(ownerId, "calendar", "limited", "personal");
      await add(ownerId, "gmail", "reconnect", "work");
      await add(ownerId, "gmail", "disconnected", "old");
      const summary = await read();
      assert.equal(summary.accounts.length, 4);
      assert.equal(summary.accounts.find((item) => item.id === gmail.id)?.status, "connected");
      assert.equal(summary.accounts.find((item) => item.id === calendar.id)?.status, "limited");
      assert.deepEqual(
        new Set(summary.accounts.map((item) => item.status)),
        new Set(["connected", "limited", "reconnect", "disconnected"]),
      );
      assert.doesNotMatch(
        JSON.stringify(summary),
        /private-|stranger-canary|subject|scopes|calendars/,
      );

      await database.transaction(ownerId, ({ connections }) =>
        connections.setHealth(gmail.id, 0, "reconnect"),
      );
      const changed = (await read()).accounts.find((item) => item.id === gmail.id);
      assert.equal(changed?.status, "reconnect");
      assert.equal(changed.revision, 1);
      assert.equal(
        (await read()).accounts.find((item) => item.id === calendar.id)?.status,
        "limited",
      );

      for (let index = 0; index < 47; index += 1)
        await add(ownerId, "gmail", "connected", `extra-${String(index)}`);
      const bounded = await read();
      assert.equal(bounded.accounts.length, 50);
      assert.equal(bounded.truncated, true);
    } finally {
      await database.close();
    }
  });
});
