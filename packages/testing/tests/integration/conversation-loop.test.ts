import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore, deliverTelegramNext } from "@winston/adapters/telegram";
import type { ModelResult } from "@winston/adapters/models";
import { createConversationLoop } from "@winston/server/conversation";
import { withTestPostgres } from "../../src/postgres";

const attempt = {
  role: "conversation" as const,
  model: "fixture",
  promptVersion: "fixture",
  elapsedMs: 0,
  firstTextMs: 0,
};
const answer = (text: string): ModelResult => ({ ok: true, text, toolCalls: [], attempt });

test("conversation answers beside running work, replays tool receipts, and drops superseded model output", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const botId = 12345;
    const telegram = createTelegramStore(connectionString, botId);
    const ownerId = randomUUID();
    let sequence = 0;
    const receive = async (text: string) => {
      sequence += 1;
      await telegram.receive({
        update_id: sequence,
        message: {
          message_id: sequence,
          date: 1_790_000_000 + sequence,
          from: { id: 123, is_bot: false, first_name: "Owner" },
          chat: { id: 123, type: "private" },
          text,
        },
      });
    };
    const consume = async () => {
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type LIKE 'telegram.message-%' ORDER BY created_at`;
      for (const event of events)
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      return database.transaction(ownerId, ({ conversations }) => conversations.snapshot(100));
    };
    const sent: string[] = [];
    const deliver = () =>
      deliverTelegramNext(
        database,
        ownerId,
        botId,
        (_chat, text) => {
          sent.push(text);
          return Promise.resolve({ state: "sent" as const, messageId: sent.length });
        },
        new AbortController().signal,
      );
    const run = async (generate: Parameters<typeof createConversationLoop>[0]["generate"]) => {
      const state = await consume();
      await createConversationLoop({ database, botId, generate })(
        ownerId,
        state.revision,
        new AbortController().signal,
      );
      return state;
    };
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const challenge = await telegram.challenge(ownerId, "session");
      await receive(`/start ${challenge.secret}`);
      await telegram.confirm(ownerId, "session", challenge.id);
      await receive("Please research something in the background");
      const initial = await consume();
      const source = initial.messages[0]?.envelope.messageId;
      assert.ok(source);
      const task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "long-job",
          objective: "Slow fixture",
          sourceMessageIds: [source],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      await receive("Quick question while that runs");
      await run((request) => {
        assert.match(JSON.stringify(request.messages), /<sent_at/);
        assert.match(JSON.stringify(request.messages), /running/);
        return Promise.resolve(answer("Quick answer."));
      });
      assert.equal(await deliver(), "sent");
      assert.deepEqual(sent, ["Quick answer."]);
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id)))?.state,
        "running",
      );

      await receive("Queue another task");
      let calls = 0;
      const state = await consume();
      const loop = createConversationLoop({
        database,
        botId,
        generate: () => {
          calls += 1;
          if (calls === 1)
            return Promise.resolve({
              ok: true,
              text: "",
              toolCalls: [
                { id: "create", name: "create_task", input: { objective: "Another fixture" } },
              ],
              attempt,
            });
          return Promise.reject(new Error("Fixture crash after task creation"));
        },
      });
      await assert.rejects(
        loop(ownerId, state.revision, new AbortController().signal),
        /Fixture crash/,
      );
      const beforeReplay = await database.transaction(ownerId, ({ tasks }) => tasks.listActive());
      assert.equal(beforeReplay.length, 2);
      await run((request) => {
        assert.equal(request.messages.filter((message) => message.role === "tool").length, 1);
        assert.match(JSON.stringify(request.messages), /Quick answer/);
        return Promise.resolve(answer("Queued."));
      });
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.listActive())).length,
        2,
      );
      await deliver();

      await receive("A request I am about to correct");
      await run(async (request) => {
        await receive("Actually use this correction");
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve();
          else
            request.signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
        });
        return answer("Stale answer must never appear");
      });
      assert.equal(await deliver(), "idle");
      await run((request) => {
        assert.match(JSON.stringify(request.messages), /Actually use this correction/);
        return Promise.resolve(answer("Correction applied."));
      });
      await deliver();
      assert.deepEqual(sent, ["Quick answer.", "Queued.", "Correction applied."]);

      await receive("Invalid tool fixture");
      let invalidCalls = 0;
      await run((request) => {
        invalidCalls += 1;
        if (invalidCalls === 1)
          return Promise.resolve({
            ok: true,
            text: "",
            toolCalls: [{ id: "invalid", name: "create_task", input: { objective: 42 } }],
            attempt,
          });
        assert.match(JSON.stringify(request.messages), /Invalid tool request/);
        return Promise.resolve(answer("No task created."));
      });
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.listActive())).length,
        2,
      );
      const final = await consume();
      const history = await database.transaction(ownerId, ({ turns }) =>
        turns.history(final.messages.map((message) => message.envelope.messageId)),
      );
      assert.equal(history.length, 3, "Undelivered response must not appear as spoken history");
      await receive("Replace that unsent reply");
      assert.equal(
        await deliver(),
        "idle",
        "New pending ingress cancels a reply before delivery begins",
      );
      await run(() => Promise.resolve(answer("Replacement.")));
      assert.equal(await deliver(), "sent");
      assert.equal(sent.at(-1), "Replacement.");

      await receive("Find a restaurant");
      await receive("In Brooklyn");
      await receive("For six people");
      const burstState = await consume();
      const timing = await sql<{ bounded: boolean }[]>`
        SELECT collect_until <= burst_started_at + interval '600 milliseconds' AS bounded
        FROM winston.conversations WHERE owner_id = ${ownerId}::uuid
      `;
      assert.equal(timing[0]?.bounded, true);
      await sql`UPDATE winston.conversations SET collect_until = clock_timestamp() + interval '1 hour' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        (await database.transaction(ownerId, ({ conversations }) => conversations.status())).ready,
        false,
      );
      await sql`UPDATE winston.conversations SET collect_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        (await database.transaction(ownerId, ({ conversations }) => conversations.status())).ready,
        true,
      );
      let restaurantCalls = 0;
      await run((request) => {
        const content = JSON.stringify(request.messages);
        assert.match(content, /Find a restaurant/);
        assert.match(content, /In Brooklyn/);
        assert.match(content, /For six people/);
        assert.match(content, /message_burst/);
        for (const message of burstState.messages.slice(-3))
          assert.match(content, new RegExp(message.envelope.messageId));
        restaurantCalls += 1;
        return Promise.resolve(
          restaurantCalls === 1
            ? {
                ok: true,
                text: "",
                toolCalls: [
                  {
                    id: "restaurant",
                    name: "create_task",
                    input: { objective: "Find a restaurant in Brooklyn for six people" },
                  },
                ],
                attempt,
              }
            : answer("Restaurant request queued."),
        );
      });
      await deliver();
      const restaurant = (
        await database.transaction(ownerId, ({ tasks }) => tasks.listActive())
      ).find((item) => item.objective.includes("Brooklyn"));
      assert.ok(restaurant);
      await receive("Separately, check my calendar tomorrow");
      let calendarCalls = 0;
      await run(() => {
        calendarCalls += 1;
        return Promise.resolve(
          calendarCalls === 1
            ? {
                ok: true,
                text: "",
                toolCalls: [
                  {
                    id: "calendar",
                    name: "create_task",
                    input: { objective: "Check tomorrow's calendar" },
                  },
                ],
                attempt,
              }
            : answer("Calendar request queued separately."),
        );
      });
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.find(restaurant.id)),
        restaurant,
      );
    } finally {
      await Promise.all([database.close(), telegram.close()]);
    }
  });
});
