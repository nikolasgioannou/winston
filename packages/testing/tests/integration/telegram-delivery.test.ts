import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { deliverTelegramNext } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("Telegram outbox serializes whole replies and never retries ambiguous sends", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const botId = 12345;
    const scope = <Result>(work: (transaction: OwnerTransaction) => Promise<Result>) =>
      database.transaction(ownerId, work);
    try {
      await scope(({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, 123, 123)`;
      const text = "word ".repeat(1000);
      const first = await scope(({ telegramOutbound }) =>
        telegramOutbound.enqueue("first", botId, text),
      );
      assert.equal(
        await scope(({ telegramOutbound }) => telegramOutbound.enqueue("first", botId, text)),
        first,
      );
      await assert.rejects(
        scope(({ telegramOutbound }) => telegramOutbound.enqueue("first", botId, "different")),
        /conflicts/,
      );
      const second = await scope(({ telegramOutbound }) =>
        telegramOutbound.enqueue("second", botId, "Second response"),
      );
      const claims = await Promise.all([
        scope(({ telegramOutbound }) => telegramOutbound.claim(botId)),
        scope(({ telegramOutbound }) => telegramOutbound.claim(botId)),
      ]);
      const claimed = claims.find((claim) => claim !== undefined);
      assert.ok(claimed);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(claimed.id, first);
      await scope(({ telegramOutbound }) =>
        telegramOutbound.settle(claimed, { state: "retry", afterSeconds: 20 }),
      );
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)), undefined);
      await sql`UPDATE winston.telegram_outbound SET available_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;

      let messageId = 100;
      const texts: string[] = [];
      const send = (_chatId: string, part: string) => {
        texts.push(part);
        return Promise.resolve({ state: "sent" as const, messageId: messageId++ });
      };
      const signal = new AbortController().signal;
      assert.equal(await deliverTelegramNext(database, ownerId, botId, send, signal), "sent");
      assert.equal(await deliverTelegramNext(database, ownerId, botId, send, signal), "sent");
      assert.equal(
        (await scope(({ telegramOutbound }) => telegramOutbound.find(first)))?.state,
        "delivered",
      );
      assert.equal(
        (await scope(({ telegramOutbound }) => telegramOutbound.find(second)))?.state,
        "pending",
      );
      assert.equal(texts.length, 2);
      assert.deepEqual(
        (await scope(({ telegramOutbound }) => telegramOutbound.find(first)))?.sentIds,
        [100, 101],
      );

      const uncertain = await scope(({ telegramOutbound }) => telegramOutbound.claim(botId));
      assert.ok(uncertain);
      await sql`UPDATE winston.telegram_outbound SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${second}::uuid`;
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)), undefined);
      assert.equal(
        (await scope(({ telegramOutbound }) => telegramOutbound.find(second)))?.state,
        "uncertain",
      );
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)), undefined);
      assert.equal(
        await scope(({ telegramOutbound }) =>
          telegramOutbound.settle(uncertain, { state: "sent", messageId: 102 }),
        ),
        true,
      );
      assert.equal(
        await scope(({ telegramOutbound }) =>
          telegramOutbound.settle(uncertain, { state: "sent", messageId: 102 }),
        ),
        false,
      );

      const third = await scope(({ telegramOutbound }) =>
        telegramOutbound.enqueue("third", botId, "Third"),
      );
      assert.equal(
        await deliverTelegramNext(
          database,
          ownerId,
          botId,
          () => Promise.reject(new Error("unknown transport outcome")),
          signal,
        ),
        "uncertain",
      );
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)), undefined);
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.abandon(third)), true);
      const revoked = await scope(({ telegramOutbound }) =>
        telegramOutbound.enqueue("revoked", botId, "Do not send"),
      );
      await sql`DELETE FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)), undefined);
      assert.equal(
        (await scope(({ telegramOutbound }) => telegramOutbound.find(revoked)))?.state,
        "canceled",
      );
      assert.equal(
        await database.transaction(randomUUID(), ({ telegramOutbound }) =>
          telegramOutbound.find(first),
        ),
        undefined,
      );
    } finally {
      await database.close();
    }
  });
});
