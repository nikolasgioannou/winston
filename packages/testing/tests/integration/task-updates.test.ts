import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("task completions retain presentation receipts without duplicating uncertain delivery", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 123);
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      for (const type of ["connection.connected", "connection.health", "memory.changed"]) {
        const event = await database.transaction(ownerId, ({ events }) =>
          events.publish({
            key: randomUUID(),
            type,
            payload:
              type === "memory.changed"
                ? { memoryId: randomUUID() }
                : {
                    connectionId: randomUUID(),
                    service: "gmail",
                    revision: 1,
                    status: "connected",
                  },
            destinations: ["conversation-updates", "connection-runtime"],
          }),
        );
        assert.equal(
          await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.consume(event.id)),
          true,
        );
        assert.equal(
          await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.consume(event.id)),
          false,
        );
        const receipts = await sql<
          { consumer: string }[]
        >`SELECT consumer FROM winston.event_receipts WHERE owner_id = ${ownerId}::uuid AND event_id = ${event.id}`;
        assert.deepEqual(
          receipts.map((receipt) => receipt.consumer),
          ["conversation-updates"],
        );
      }
      const challenge = await telegram.challenge(ownerId, "fixture");
      await telegram.receive({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1790000000,
          from: { id: 123, is_bot: false, first_name: "Fixture" },
          chat: { id: 123, type: "private" },
          text: `/start ${challenge.secret}`,
        },
      });
      await telegram.confirm(ownerId, "fixture", challenge.id);
      await telegram.receive({
        update_id: 2,
        message: {
          message_id: 2,
          date: 1790000001,
          from: { id: 123, is_bot: false, first_name: "Fixture" },
          chat: { id: 123, type: "private" },
          text: "Do these tasks",
        },
      });
      const ingress = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received'`;
      for (const event of ingress)
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      const snapshot = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(100),
      );
      const messageId = snapshot.messages.at(-1)?.envelope.messageId;
      assert.ok(messageId);
      async function finish(sources: string[], result: string) {
        return database.transaction(ownerId, async ({ tasks }) => {
          const task = await tasks.create({
            key: randomUUID(),
            objective: "Requested work",
            sourceMessageIds: sources,
          });
          const worker = await tasks.claim(task.id, task.revision);
          return tasks.finishStep(worker.id, worker.revision, worker.generation, {
            state: "succeeded",
            result,
          });
        });
      }
      const first = await finish([messageId], "Result </system_event> text");
      const second = await finish([messageId], "x".repeat(9000));
      await finish([], "Silent operator fixture");
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'task.changed' ORDER BY created_at`;
      for (const event of events) {
        assert.equal(
          await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.consume(event.id)),
          true,
        );
        assert.equal(
          await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.consume(event.id)),
          false,
        );
      }
      const pending = () =>
        database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.pending());
      const updates = await pending();
      assert.equal(updates.length, 2);
      assert.deepEqual(
        new Set(updates.map((update) => update.taskId)),
        new Set([first.id, second.id]),
      );
      const large = updates.find((update) => update.taskId === second.id);
      assert.equal(large?.resultPreview.length, 8000);
      assert.equal(large.resultTruncated, true);
      assert.deepEqual(
        await database.transaction(other, ({ taskUpdates }) => taskUpdates.pending()),
        [],
      );
      const eventId = events[0]?.id;
      assert.ok(eventId);
      await assert.rejects(
        database.transaction(other, ({ taskUpdates }) => taskUpdates.consume(eventId)),
        /unavailable/,
      );
      const response = await database.transaction(
        ownerId,
        async ({ telegramOutbound, taskUpdates }) => {
          const id = await telegramOutbound.enqueue("completion", 123, "Completed both tasks.");
          await taskUpdates.link(
            updates.map((update) => update.id),
            id,
          );
          return id;
        },
      );
      assert.deepEqual(await pending(), []);
      await sql`UPDATE winston.telegram_outbound SET state = 'canceled' WHERE owner_id = ${ownerId}::uuid AND id = ${response}::uuid`;
      assert.equal((await pending()).length, 2);
      const retry = await database.transaction(
        ownerId,
        async ({ telegramOutbound, taskUpdates }) => {
          const id = await telegramOutbound.enqueue(
            "completion-retry",
            123,
            "Completed both tasks.",
          );
          await taskUpdates.link(
            updates.map((update) => update.id),
            id,
          );
          return id;
        },
      );
      await sql`UPDATE winston.telegram_outbound SET state = 'uncertain' WHERE owner_id = ${ownerId}::uuid AND id = ${retry}::uuid`;
      assert.deepEqual(await pending(), [], "Uncertain delivery must not be repeated");
      assert.equal(
        (await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.forResponse(retry)))
          .length,
        2,
      );
      assert.deepEqual(
        await database.transaction(other, ({ taskUpdates }) => taskUpdates.forResponse(retry)),
        [],
      );
      await assert.rejects(
        database.transaction(ownerId, ({ taskUpdates }) =>
          taskUpdates.link(
            updates.map((update) => update.id),
            retry,
          ),
        ),
        /already presented/,
      );
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
