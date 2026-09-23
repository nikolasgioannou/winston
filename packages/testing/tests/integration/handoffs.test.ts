import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { googleScopes } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("handoffs resume once with verified owner evidence and reject stale task intent", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const connectionId = randomUUID();
      await sql`INSERT INTO winston.credentials (owner_id, id, provider, revision, encrypted)
        VALUES (${ownerId}::uuid, ${connectionId}::uuid, 'google', 0, '{}'::jsonb)`;
      const connection = {
        id: connectionId,
        service: "gmail",
        subject: "fixture",
        email: "fixture@example.com",
        scopes: [...googleScopes.gmail],
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${connectionId}::uuid, 'fixture', 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      async function prepare() {
        const worker = await database.transaction(ownerId, async ({ tasks }) => {
          const task = await tasks.create({
            key: randomUUID(),
            objective: "Connect Gmail",
            sourceMessageIds: [],
          });
          return tasks.claim(task.id, task.revision);
        });
        const request = {
          key: randomUUID(),
          task: { id: worker.id, revision: worker.revision, generation: worker.generation },
          target: { kind: "connection" as const, service: "gmail" as const, connectionId },
          detail: "Connect Gmail",
        };
        const handoff = await database.transaction(ownerId, ({ handoffs }) =>
          handoffs.prepare(request),
        );
        assert.deepEqual(
          await database.transaction(ownerId, ({ handoffs }) => handoffs.prepare(request)),
          handoff,
        );
        await assert.rejects(
          database.transaction(ownerId, ({ handoffs }) =>
            handoffs.prepare({ ...request, detail: "Changed" }),
          ),
          /conflicts/,
        );
        await assert.rejects(
          database.transaction(ownerId, ({ handoffs }) =>
            handoffs.prepare({ ...request, key: randomUUID() }),
          ),
          /stale/,
        );
        return handoff;
      }
      const first = await prepare();
      const complete = (id: string) =>
        database.transaction(ownerId, ({ handoffs }) =>
          handoffs.completeVerified(id, { kind: "connection", connectionId }),
        );
      assert.equal(
        await database.transaction(stranger, ({ handoffs }) => handoffs.find(first.id)),
        null,
      );
      assert.equal(
        await database.transaction(stranger, ({ handoffs }) =>
          handoffs.completeVerified(first.id, { kind: "connection", connectionId }),
        ),
        null,
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ handoffs }) =>
            handoffs.completeVerified(first.id, { kind: "browser", sessionId: randomUUID() }),
          )
        )?.resumed,
        false,
      );
      const results = await Promise.all([complete(first.id), complete(first.id)]);
      assert.equal(results.filter((result) => result?.resumed).length, 1);
      assert.equal((await complete(first.id))?.handoff.resolutionId, connectionId);
      const expired = await prepare();
      await sql`UPDATE winston.handoffs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal((await complete(expired.id))?.handoff.state, "expired");
      assert.equal(
        (await database.transaction(ownerId, ({ handoffs }) => handoffs.renew(expired.id)))?.state,
        "pending",
      );
      assert.equal((await complete(expired.id))?.resumed, true);
      for (const operation of ["cancel", "steer"] as const) {
        const stale = await prepare();
        await database.transaction(ownerId, ({ tasks }) =>
          operation === "cancel"
            ? tasks.cancel(stale.taskId, stale.taskRevision)
            : tasks.steer(stale.taskId, stale.taskRevision, "Different request"),
        );
        assert.equal((await complete(stale.id))?.handoff.state, "invalidated");
        assert.equal(
          (await database.transaction(ownerId, ({ handoffs }) => handoffs.renew(stale.id)))?.state,
          "invalidated",
        );
      }
      const abandoned = await prepare();
      assert.equal(
        (await database.transaction(ownerId, ({ handoffs }) => handoffs.abandon(abandoned.id)))
          ?.state,
        "abandoned",
      );
      assert.equal((await complete(abandoned.id))?.resumed, false);
      const limited = await prepare();
      await sql`UPDATE winston.google_connections SET document = ${JSON.stringify({ ...connection, scopes: [] })}::text::jsonb WHERE id = ${connectionId}::uuid`;
      assert.equal((await complete(limited.id))?.resumed, false);
    } finally {
      await database.close();
    }
  });
});
