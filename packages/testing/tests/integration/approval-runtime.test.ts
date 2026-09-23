import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore, deliverTelegramNext } from "@winston/adapters/telegram";
import { startBackgroundRuntime } from "@winston/server/background-runtime";
import type { TelegramKeyboard } from "@winston/contracts/telegram";
import { withTestPostgres } from "../../src/postgres";

test("waiting tasks present one card and resume after decisions or expiry", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const botId = 123;
    const ownerId = randomUUID();
    const store = createTelegramStore(connectionString, botId);
    let runtime: Awaited<ReturnType<typeof startBackgroundRuntime>> | undefined;
    const admitted = new Set<string>();
    const notices: string[] = [];
    async function until(check: () => Promise<boolean>) {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(25);
      }
      assert.fail("Approval runtime did not advance.");
    }
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, 1, 1)`;
      const device = await database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Approval runtime fixture");
        const paired = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(paired);
        return paired.device;
      });
      runtime = await startBackgroundRuntime({
        database,
        directConnectionString: connectionString,
        botId,
        jobs: {
          work: () => Promise.resolve(),
          inspect: () => Promise.resolve(undefined),
          enqueue: (_workload, reference) => {
            admitted.add(reference.referenceId);
            return Promise.resolve(randomUUID());
          },
        },
        generate: () => Promise.reject(new Error("No model calls expected")),
        notice: (code) => {
          notices.push(code);
        },
      });
      for (const outcome of ["approve", "reject", "expire", "steer"] as const) {
        const { task, action } = await database.transaction(ownerId, async ({ tasks, actions }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Review synthetic action",
            sourceMessageIds: [],
          });
          const running = await tasks.claim(queued.id, queued.revision);
          const action = await actions.prepare({
            key: randomUUID(),
            task: { id: running.id, revision: running.revision, generation: running.generation },
            authorization: {
              target: { kind: "device", id: device.id, resource: null },
              operation: "device.command",
            },
            arguments: { command: "echo synthetic" },
          });
          const task = await tasks.finishStep(running.id, running.revision, running.generation, {
            state: "waiting",
            blocker: { kind: "approval", referenceId: action.id, detail: "Approval required" },
          });
          return { task, action };
        });
        const cards = () =>
          sql<
            { outboundId: string }[]
          >`SELECT outbound_id AS "outboundId" FROM winston.telegram_approvals WHERE owner_id = ${ownerId}::uuid AND action_id = ${action.id}::uuid`;
        await until(async () => (await cards()).length === 1);
        const card = (await cards())[0];
        assert.ok(card);
        assert.equal(admitted.has(task.id), false);
        if (outcome === "approve" || outcome === "reject") {
          let keyboard: TelegramKeyboard | undefined;
          assert.equal(
            await deliverTelegramNext(
              database,
              ownerId,
              botId,
              (_chat, _text, _signal, markup) => {
                keyboard = markup;
                return Promise.resolve({ state: "sent", messageId: 50 });
              },
              new AbortController().signal,
            ),
            "sent",
          );
          const token =
            keyboard?.inline_keyboard[0]?.[outcome === "approve" ? 0 : 1]?.callback_data;
          assert.ok(token);
          assert.deepEqual(
            await store.receive({
              update_id: 500,
              callback_query: {
                id: `query-${outcome}`,
                from: { id: 1, is_bot: false },
                data: token,
                message: {
                  message_id: 50,
                  date: 1,
                  chat: { id: 1, type: "private" },
                  from: { id: botId, is_bot: true, first_name: "Winston" },
                },
              },
            }),
            {
              callbackId: `query-${outcome}`,
              text: outcome === "approve" ? "Approved." : "Rejected.",
            },
          );
        } else if (outcome === "expire") {
          await sql`UPDATE winston.actions SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${action.id}::uuid`;
        } else {
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.steer(task.id, task.revision, "Cancel original intent"),
          );
        }
        await until(() => Promise.resolve(admitted.has(task.id)));
        if (outcome === "expire" || outcome === "steer") {
          assert.equal(
            await database.transaction(ownerId, ({ telegramOutbound }) =>
              telegramOutbound.claim(botId),
            ),
            undefined,
          );
          assert.equal(
            (
              await database.transaction(ownerId, ({ telegramOutbound }) =>
                telegramOutbound.find(card.outboundId),
              )
            )?.state,
            "canceled",
          );
        }
        if (outcome === "expire")
          assert.equal(
            (await database.transaction(ownerId, ({ actions }) => actions.find(action.id)))?.state,
            "invalidated",
          );
        assert.equal((await cards()).length, 1);
      }
      assert.deepEqual(notices, []);
    } finally {
      await runtime?.stop();
      await store.close();
      await database.close();
    }
  });
});
