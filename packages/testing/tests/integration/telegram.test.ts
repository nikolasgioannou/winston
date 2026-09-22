import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

function update(id: number, sender: number, text: string) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_790_000_000,
      from: { id: sender, is_bot: false, first_name: "Test owner" },
      chat: { id: sender, type: "private" },
      text,
    },
  };
}

test("Telegram pairing requires the initiating web session and ingress deduplicates with immutable receipt metadata", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const store = createTelegramStore(connectionString, 987654);
    const otherBot = createTelegramStore(connectionString, 987655);
    const ownerId = randomUUID();

    try {
      await database.transaction(ownerId, async ({ owners }) => {
        await owners.ensure();
        await owners.updateTimezone("America/New_York", 0);
      });
      assert.equal(await store.receive(update(1, 123, "hello")), "ignored");
      const challenge = await store.challenge(ownerId, "session-one");
      const start = update(2, 123, `/start ${challenge.secret}`);
      assert.equal(await otherBot.receive(start), "ignored");
      assert.equal(
        await store.receive({
          ...start,
          message: { ...start.message, chat: { id: 999, type: "group" } },
        }),
        "ignored",
      );
      assert.equal(await store.receive(start), "candidate");
      assert.equal(await store.receive(update(3, 456, `/start ${challenge.secret}`)), "ignored");
      assert.equal((await store.status(ownerId, "other-session")).challenge, null);
      assert.equal(await store.confirm(ownerId, "other-session", challenge.id), false);
      assert.equal(await store.receive(update(4, 123, "still unpaired")), "ignored");
      assert.equal(await store.confirm(ownerId, "session-one", challenge.id), true);
      assert.equal(await store.confirm(ownerId, "session-one", challenge.id), false);
      assert.equal(await store.receive(update(5, 456, "wrong sender")), "ignored");

      const results = await Promise.all([
        store.receive(update(6, 123, "hello")),
        store.receive(update(6, 123, "hello")),
      ]);
      assert.deepEqual(results.sort(), ["accepted", "duplicate"]);
      const before = await sql<
        {
          received_at: Date;
          timezone_snapshot: { timezone: string };
          payload: { message: { date: number } };
        }[]
      >`SELECT received_at, timezone_snapshot, payload FROM winston.telegram_updates`;
      assert.equal(before.length, 1);
      assert.equal(before[0]?.timezone_snapshot.timezone, "America/New_York");
      assert.equal(before[0].payload.message.date, 1_790_000_000);
      await database.transaction(ownerId, ({ owners }) => owners.updateTimezone("Asia/Tokyo", 1));
      assert.equal(await store.receive(update(6, 123, "hello")), "duplicate");
      assert.deepEqual(
        await sql`SELECT received_at, timezone_snapshot, payload FROM winston.telegram_updates`,
        before,
      );
      const counts = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston.outbox WHERE destination = 'conversation-inbox'`;
      assert.equal(counts[0]?.count, 1);

      await store.unpair(ownerId);
      assert.equal(await store.receive(update(7, 123, "revoked")), "ignored");
      const next = await store.challenge(ownerId, "session-two");
      await store.receive(update(8, 456, `/start ${next.secret}`));
      assert.equal(await store.confirm(ownerId, "session-two", next.id), true);
      assert.equal(await store.receive(update(9, 123, "old identity")), "ignored");
      assert.equal(await store.receive(update(10, 456, "new identity")), "accepted");

      const otherOwner = randomUUID();
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      const stolen = await store.challenge(otherOwner, "session-three");
      await store.receive(update(11, 456, `/start ${stolen.secret}`));
      await assert.rejects(store.confirm(otherOwner, "session-three", stolen.id));
      assert.equal((await store.status(ownerId, "session-two")).binding?.userId, "456");

      const expired = await store.challenge(otherOwner, "session-three");
      await sql`UPDATE winston.telegram_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal(await store.receive(update(12, 789, `/start ${expired.secret}`)), "ignored");
      assert.equal(await store.confirm(otherOwner, "session-three", expired.id), false);
    } finally {
      await Promise.all([database.close(), store.close(), otherBot.close()]);
    }
  });
});
