import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("Telegram approval requires the exact delivered card and current authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const botId = 12345;
    const userId = 123;
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, ${userId}, ${userId})`;
      const device = await database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Approval test");
        const paired = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(paired);
        return paired.device;
      });
      const authorization = {
        target: { kind: "device" as const, id: device.id, resource: null },
        operation: "device.command" as const,
      };
      async function prepare() {
        return database.transaction(
          ownerId,
          async ({ tasks, actions, telegramApprovals, telegramOutbound }) => {
            const queued = await tasks.create({
              key: randomUUID(),
              objective: "Approval test",
              sourceMessageIds: [],
            });
            const running = await tasks.claim(queued.id, queued.revision);
            const action = await actions.prepare({
              key: randomUUID(),
              task: { id: running.id, revision: running.revision, generation: running.generation },
              authorization,
              arguments: { command: "echo synthetic" },
            });
            const task = await tasks.finishStep(running.id, running.revision, running.generation, {
              state: "waiting",
              blocker: { kind: "approval", referenceId: action.id, detail: "Review command" },
            });
            const card = await telegramApprovals.prepare(action.id, botId);
            assert.ok(card);
            assert.deepEqual(await telegramApprovals.prepare(action.id, botId), card);
            const delivery = await telegramOutbound.claim(botId);
            assert.ok(delivery);
            assert.equal(delivery.id, card.outboundId);
            const buttons = delivery.keyboard?.inline_keyboard[0];
            const approve = buttons?.[0]?.callback_data;
            const reject = buttons?.[1]?.callback_data;
            assert.ok(approve && reject && approve !== reject);
            return { action, task, delivery, approve, reject };
          },
        );
      }
      const card = await prepare();
      const callback = { botId, userId, chatId: userId, messageId: 90, token: card.approve };
      const decide = (input = callback, owner = ownerId) =>
        database.transaction(owner, ({ telegramApprovals }) => telegramApprovals.decide(input));
      assert.equal(await decide(), null);
      await database.transaction(ownerId, ({ telegramOutbound }) =>
        telegramOutbound.settle(card.delivery, { state: "uncertain" }),
      );
      assert.equal(await decide(), null);
      await database.transaction(ownerId, ({ telegramOutbound }) =>
        telegramOutbound.settle(card.delivery, { state: "sent", messageId: 90 }),
      );
      for (const invalid of [
        { userId: 456 },
        { chatId: 456 },
        { botId: 456 },
        { messageId: 91 },
        { token: `ap_${"x".repeat(43)}` },
      ])
        assert.equal(await decide({ ...callback, ...invalid }), null);
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(await decide(callback, stranger), null);
      const results = await Promise.all([decide(), decide()]);
      assert.deepEqual(results.map((result) => result?.duplicate).sort(), [false, true]);
      assert.ok(results.every((result) => result?.state === "approved"));
      assert.deepEqual(await decide({ ...callback, token: card.reject }), {
        state: "approved",
        duplicate: true,
      });
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(card.action.id)))
          ?.revision,
        1,
      );

      for (const change of [
        "expired",
        "steered",
        "canceled",
        "denied",
        "unpaired",
        "reject",
      ] as const) {
        const next = await prepare();
        await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.settle(next.delivery, { state: "sent", messageId: 100 }),
        );
        if (change === "expired")
          await sql`UPDATE winston.actions SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${next.action.id}::uuid`;
        if (change === "steered")
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.steer(next.task.id, next.task.revision, "Corrected intent"),
          );
        if (change === "canceled")
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.cancel(next.task.id, next.task.revision),
          );
        if (change === "denied")
          await database.transaction(ownerId, ({ authorization: policies }) =>
            policies.put({ ...authorization, revision: 0, decision: "deny" }),
          );
        if (change === "unpaired")
          await sql`DELETE FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid`;
        const result = await decide({
          ...callback,
          messageId: 100,
          token: change === "reject" ? next.reject : next.approve,
        });
        if (change === "unpaired") {
          assert.equal(result, null);
          await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, ${userId}, ${userId})`;
        } else
          assert.deepEqual(result, {
            state: change === "reject" ? "denied" : "invalidated",
            duplicate: false,
          });
        if (change === "denied")
          await database.transaction(ownerId, ({ authorization: policies }) =>
            policies.put({ ...authorization, revision: 1, decision: "ask" }),
          );
      }
    } finally {
      await database.close();
    }
  });
});
