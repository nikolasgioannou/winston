import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import type { ModelResult } from "@winston/adapters/models";
import { createConversationLoop } from "@winston/server/conversation";
import { withTestPostgres } from "../../src/postgres";

const answer: ModelResult = {
  ok: true,
  text: "Synthetic reply",
  toolCalls: [],
  attempt: {
    role: "conversation",
    model: "fixture",
    promptVersion: "fixture",
    elapsedMs: 0,
    firstTextMs: 0,
  },
};

test("typing uses current paired authority and ends with publication or supersession", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const botId = 12345;
    const telegram = createTelegramStore(connectionString, botId);
    const shutdown = new AbortController();
    const model = Promise.withResolvers<ModelResult>();
    let running: Promise<void> | undefined;
    let sequence = 0;
    const receive = async () => {
      sequence++;
      await telegram.receive({
        update_id: sequence,
        message: {
          message_id: sequence,
          date: 1_790_000_000 + sequence,
          from: { id: 123, is_bot: false, first_name: "Fixture" },
          chat: { id: 123, type: "private" },
          text: "Synthetic request",
        },
      });
    };
    async function consume() {
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received' ORDER BY created_at`;
      for (const event of events)
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      return database.transaction(ownerId, ({ conversations }) => conversations.status());
    }
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, 123, 123)`;
      assert.equal(
        await database.transaction(other, ({ telegramOutbound }) =>
          telegramOutbound.pairedChat(botId),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.pairedChat(botId + 1),
        ),
        null,
      );
      await receive();
      const state = await consume();
      const indicated = Promise.withResolvers<AbortSignal>();
      running = createConversationLoop({
        database,
        botId,
        generate: () => model.promise,
        indicate: (chatId, signal) => {
          assert.equal(chatId, "123");
          indicated.resolve(signal);
          return Promise.resolve(true);
        },
      })(ownerId, state.revision, shutdown.signal);
      const typingSignal = await indicated.promise;
      assert.equal(typingSignal.aborted, false);
      model.resolve(answer);
      await running;
      assert.equal(typingSignal.aborted, true);
      assert.equal(
        (await database.transaction(ownerId, ({ conversations }) => conversations.status()))
          .responseRevision,
        state.inputRevision,
      );

      await receive();
      const next = await consume();
      const started = Promise.withResolvers<undefined>();
      let indicators = 0;
      running = createConversationLoop({
        database,
        botId,
        generate: (request) =>
          new Promise((resolve) => {
            started.resolve(undefined);
            request.signal.addEventListener(
              "abort",
              () => {
                resolve(answer);
              },
              { once: true },
            );
          }),
        indicate: () => {
          indicators++;
          return Promise.resolve(true);
        },
      })(ownerId, next.revision, shutdown.signal);
      await started.promise;
      await receive();
      await running;
      assert.equal(indicators, 0);
      assert.equal(
        (await database.transaction(ownerId, ({ conversations }) => conversations.status()))
          .responseRevision,
        state.inputRevision,
      );
      await sql`DELETE FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.pairedChat(botId),
        ),
        null,
      );
    } finally {
      shutdown.abort();
      model.resolve(answer);
      await running?.catch(() => {});
      await telegram.close();
      await database.close();
    }
  });
});
