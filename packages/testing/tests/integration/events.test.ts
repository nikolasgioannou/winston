import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, dispatchNext, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

const publication = {
  key: "provider-update-123",
  type: "inbox.received",
  payload: { message: "hello", metadata: { sample: true } },
  destinations: ["conversation"],
};

test("event publication is atomic, immutable, owner-scoped and recoverable after reopening the database", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    let database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const otherId = randomUUID();

    try {
      await assert.rejects(
        database.transaction(ownerId, async ({ owners, events }) => {
          await owners.ensure();
          await events.publish(publication);
          throw new Error("Injected transaction failure");
        }),
      );
      assert.equal(await database.transaction(ownerId, ({ owners }) => owners.find()), undefined);

      const event = await database.transaction(ownerId, async ({ owners, events }) => {
        await owners.ensure();
        return events.publish(publication);
      });
      const duplicate = await database.transaction(ownerId, ({ events }) =>
        events.publish({
          ...publication,
          payload: { metadata: { sample: true }, message: "hello" },
          destinations: ["conversation", "conversation"],
        }),
      );
      assert.deepEqual(duplicate, event);
      await assert.rejects(
        database.transaction(ownerId, ({ events }) =>
          events.publish({
            ...publication,
            payload: { message: "different" },
          }),
        ),
        /conflicts/,
      );
      assert.equal(
        await database.transaction(otherId, ({ events }) => events.find(event.id)),
        undefined,
      );

      // No enqueue happened after commit. A new database client can recover the pending event.
      await database.close();
      database = createDatabase({ connectionString, onConnectionError: () => {} });
      const received: string[] = [];
      const result = await dispatchNext(
        database,
        ownerId,
        "conversation",
        (delivered) => {
          received.push(delivered.id);

          return Promise.resolve();
        },
        new AbortController().signal,
      );
      assert.equal(result, "delivered");
      assert.deepEqual(received, [event.id]);
      assert.equal(
        await dispatchNext(
          database,
          ownerId,
          "conversation",
          () => {
            assert.fail("Already delivered event must not be claimed again.");
          },
          new AbortController().signal,
        ),
        "idle",
      );
    } finally {
      await database.close();
    }
  });
});

test("competing dispatchers fence expired leases and expose safe retry state", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();

    try {
      const event = await database.transaction(ownerId, async ({ owners, events }) => {
        await owners.ensure();
        return events.publish(publication);
      });
      const claims = await Promise.all([
        database.transaction(ownerId, ({ events }) => events.claim("conversation")),
        database.transaction(ownerId, ({ events }) => events.claim("conversation")),
      ]);
      const leases = claims.filter((lease) => lease !== undefined);
      assert.equal(leases.length, 1);
      const first = leases[0];
      assert.ok(first);

      await sql`UPDATE winston.outbox SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      const second = await database.transaction(ownerId, ({ events }) =>
        events.claim("conversation"),
      );
      assert.ok(second);
      assert.notEqual(second.token, first.token);
      assert.equal(second.attempt, 2);
      assert.equal(
        await database.transaction(ownerId, ({ events }) => events.settle(first, true)),
        false,
      );
      await assert.rejects(
        database.transaction(randomUUID(), ({ events }) => events.settle(second, true)),
        /another owner/,
      );
      assert.equal(
        await database.transaction(ownerId, ({ events }) => events.settle(second, false)),
        true,
      );
      const status = await database.transaction(ownerId, ({ events }) =>
        events.status(event.id, "conversation"),
      );
      assert.equal(status?.attempts, 2);
      assert.equal(status.failureCode, "delivery-failed");
      assert.equal(status.leaseToken, null);
      assert.equal(status.deliveredAt, null);
      assert.equal(
        await database.transaction(ownerId, ({ events }) => events.claim("conversation")),
        undefined,
      );
      assert.equal(
        await database.transaction(randomUUID(), ({ events }) =>
          events.status(event.id, "conversation"),
        ),
        undefined,
      );

      await sql`UPDATE winston.outbox SET available_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;
      const cancellation = new AbortController();
      assert.equal(
        await dispatchNext(
          database,
          ownerId,
          "conversation",
          () => {
            cancellation.abort();

            return new Promise<void>(() => {});
          },
          cancellation.signal,
        ),
        "retry",
      );
    } finally {
      await database.close();
    }
  });
});

test("consumer writes and receipts roll back together, and redelivery after lost acknowledgement is idempotent", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();

    try {
      const event = await database.transaction(ownerId, async ({ owners, events }) => {
        await owners.ensure();
        return events.publish(publication);
      });
      await database.transaction(ownerId, async ({ owners, events }) => {
        await assert.rejects(
          events.consume(event.id, "conversation", async () => {
            await owners.updateTimezone("Europe/London", 0);
            throw new Error("Injected consumer failure");
          }),
        );
        assert.equal((await owners.timezone()).revision, 0);
      });

      let effects = 0;
      const consume = () =>
        database.transaction(ownerId, ({ owners, events }) =>
          events.consume(event.id, "conversation", async () => {
            effects += 1;
            await owners.updateTimezone("Asia/Tokyo", 0);
          }),
        );
      assert.equal(
        await dispatchNext(
          database,
          ownerId,
          "conversation",
          async () => {
            assert.equal(await consume(), true);
            throw new Error("sensitive transport detail must not be persisted");
          },
          new AbortController().signal,
        ),
        "retry",
      );
      const status = await database.transaction(ownerId, ({ events }) =>
        events.status(event.id, "conversation"),
      );
      assert.equal(status?.failureCode, "delivery-failed");
      await sql`UPDATE winston.outbox SET available_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;

      assert.equal(
        await dispatchNext(
          database,
          ownerId,
          "conversation",
          async () => {
            assert.equal(await consume(), false);
          },
          new AbortController().signal,
        ),
        "delivered",
      );
      assert.equal(effects, 1);
      assert.equal(
        (await database.transaction(ownerId, ({ owners }) => owners.timezone())).revision,
        1,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ events }) =>
          events.consume(event.id, "unrelated", async () => {}),
        ),
        /not an event destination/,
      );
    } finally {
      await database.close();
    }
  });
});
