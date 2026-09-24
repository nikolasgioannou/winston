import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("schedule sources retain original versions without inventing legacy provenance", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 1234);
    const ownerId = randomUUID();
    const other = randomUUID();
    const scope = <T>(work: (value: OwnerTransaction) => Promise<T>) =>
      database.transaction(ownerId, work);
    try {
      await scope(({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      const challenge = await telegram.challenge(ownerId, "fixture");
      const receive = (id: number, text: string) =>
        telegram.receive({
          update_id: id,
          message: {
            message_id: id,
            date: 1_790_000_000 + id,
            from: { id: 123, is_bot: false, first_name: "Owner" },
            chat: { id: 123, type: "private" },
            text,
          },
        });
      await receive(1, `/start ${challenge.secret}`);
      await telegram.confirm(ownerId, "fixture", challenge.id);
      await receive(2, "Remind me tomorrow.");
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received'`;
      for (const event of events)
        await scope(({ conversations }) => conversations.consumeTelegram(event.id));
      const snapshot = await scope(({ conversations }) => conversations.snapshot(10));
      const message = snapshot.messages[0]?.envelope;
      assert.ok(message);
      const input = {
        key: "source",
        objective: "Reminder",
        sourceMessageIds: [message.messageId],
        timing: { kind: "once" as const, startAt: "2030-01-01T14:00:00.000Z", timezone: "UTC" },
      };
      const schedule = await scope(({ schedules }) => schedules.create(input));
      assert.deepEqual(schedule.sources, [{ messageId: message.messageId, revision: 0 }]);
      const source = (await scope(({ schedules }) => schedules.sources(schedule.id))).items[0];
      assert.ok(source?.status === "current");
      assert.equal(source.text, message.input.text);
      assert.deepEqual(source.sentAt, message.sentAt);
      await assert.rejects(
        database.transaction(other, ({ schedules }) => schedules.sources(schedule.id)),
        /unavailable/,
      );
      await assert.rejects(
        database.transaction(other, ({ schedules }) => schedules.create(input)),
        /unavailable/,
      );

      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${message.messageId}::uuid`;
      assert.deepEqual(
        (await scope(({ schedules }) => schedules.create(input))).sources,
        schedule.sources,
      );
      const edited = await scope(({ schedules }) =>
        schedules.update(schedule.id, 0, { ...input, objective: "Updated reminder" }),
      );
      assert.deepEqual(edited.sources, schedule.sources);
      assert.deepEqual((await scope(({ schedules }) => schedules.sources(schedule.id))).items, [
        { messageId: message.messageId, revision: 0, status: "changed" },
      ]);

      const fresh = await scope(({ schedules }) => schedules.create({ ...input, key: "fresh" }));
      assert.deepEqual(fresh.sources, [{ messageId: message.messageId, revision: 1 }]);
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{input,text}', to_jsonb(${"x".repeat(4500)}::text)) WHERE owner_id = ${ownerId}::uuid AND id = ${message.messageId}::uuid`;
      const excerpt = (await scope(({ schedules }) => schedules.sources(fresh.id))).items[0];
      assert.ok(excerpt?.status === "current");
      assert.equal(excerpt.text.length, 4000);
      assert.equal(excerpt.truncated, true);

      await sql`UPDATE winston.schedules SET document = document - 'sources' WHERE owner_id = ${ownerId}::uuid AND id = ${fresh.id}::uuid`;
      const legacy = await scope(({ schedules }) => schedules.update(fresh.id, 0, input));
      assert.deepEqual(legacy.sources, [{ messageId: message.messageId, revision: null }]);
      assert.deepEqual((await scope(({ schedules }) => schedules.sources(fresh.id))).items, [
        { messageId: message.messageId, revision: null, status: "uncaptured" },
      ]);
      const missing = randomUUID();
      await sql`UPDATE winston.schedules SET document = document || jsonb_build_object('sourceMessageIds', jsonb_build_array(${missing}::text),
        'sources', jsonb_build_array(jsonb_build_object('messageId', ${missing}::text, 'revision', 0))) WHERE owner_id = ${ownerId}::uuid AND id = ${schedule.id}::uuid`;
      assert.deepEqual((await scope(({ schedules }) => schedules.sources(schedule.id))).items, [
        { messageId: missing, revision: 0, status: "unavailable" },
      ]);
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
