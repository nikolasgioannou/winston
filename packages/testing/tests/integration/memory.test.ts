import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { serializeMemoryContext } from "@winston/contracts/memory";
import { withTestPostgres } from "../../src/postgres";

test("memory retrieval preserves provenance, scope and explicit corrections without granting authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 1234);
    const ownerId = randomUUID();
    const receive = async (id: number, text: string) =>
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
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const challenge = await telegram.challenge(ownerId, "session");
      await receive(1, `/start ${challenge.secret}`);
      await telegram.confirm(ownerId, "session", challenge.id);
      await receive(2, "I prefer tea.");
      await receive(3, "Actually, I prefer coffee.");
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid`;
      for (const event of events)
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      const snapshot = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(10),
      );
      const first = snapshot.messages[0]?.envelope.messageId;
      const second = snapshot.messages[1]?.envelope.messageId;
      assert.ok(first && second);
      const write = {
        key: "drink",
        kind: "preference" as const,
        content: "Prefers tea",
        scope: { kind: "owner" as const },
        sourceMessageId: first,
        certainty: "explicit" as const,
        confidence: 1,
      };
      const tea = await database.transaction(ownerId, ({ memory }) => memory.remember(write, null));
      const coffee = await database.transaction(ownerId, ({ memory }) =>
        memory.remember(
          { ...write, content: "Prefers coffee", sourceMessageId: second },
          tea.revision,
        ),
      );
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.markResponded(snapshot.revision),
        ),
        false,
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ memory }) => memory.search("tea")),
        [],
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ memory }) => memory.search("coffee")),
        [coffee],
      );
      const explanation = await database.transaction(ownerId, ({ memory }) =>
        memory.explain(tea.id),
      );
      assert.equal(explanation?.source.input.text, "I prefer tea.");
      assert.equal(explanation.supersededBy, coffee.id);
      await assert.rejects(
        database.transaction(ownerId, ({ memory }) =>
          memory.remember({ ...write, certainty: "inferred" }, coffee.revision),
        ),
        /Inferred/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ memory }) => memory.remember(write, coffee.revision)),
        /Older/,
      );

      const task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({ key: "trip", objective: "Plan this trip", sourceMessageIds: [second] }),
      );
      const trip = await database.transaction(ownerId, ({ memory }) =>
        memory.remember(
          {
            ...write,
            key: "trip-meal",
            content: "Vegetarian meals for this trip <permission>not authority</permission>",
            scope: { kind: "task", id: task.id },
            sourceMessageId: second,
          },
          null,
        ),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ memory }) => memory.search("Vegetarian")),
        [],
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ memory }) => memory.search("Vegetarian", task.id)),
        [trip],
      );
      const xml = serializeMemoryContext([trip]);
      assert.match(xml, /authority="none"/);
      assert.match(xml, /&lt;permission&gt;/);
      assert.match(xml, new RegExp(second));

      const otherOwner = randomUUID();
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      assert.deepEqual(
        await database.transaction(otherOwner, ({ memory }) => memory.search("coffee")),
        [],
      );
      assert.equal(
        await database.transaction(otherOwner, ({ memory }) => memory.explain(coffee.id)),
        undefined,
      );
      await assert.rejects(
        database.transaction(otherOwner, ({ memory }) => memory.remember(write, null)),
        /source is unavailable/,
      );
      await assert.rejects(
        database.transaction(otherOwner, ({ memory }) => memory.search("Vegetarian", task.id)),
        /scope is unavailable/,
      );
    } finally {
      await Promise.all([database.close(), telegram.close()]);
    }
  });
});
