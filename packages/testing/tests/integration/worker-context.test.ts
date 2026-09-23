import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createUserMessage, serializeUserMessage } from "@winston/contracts/messages";
import { withTestPostgres } from "../../src/postgres";

test("worker context preserves receipts and scoped resources across cooperative yielding", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    try {
      for (const owner of [ownerId, other])
        await database.transaction(owner, ({ owners }) => owners.ensure());
      const conversation = await database.transaction(ownerId, ({ conversations }) =>
        conversations.status(),
      );
      const message = createUserMessage(
        {
          ownerId,
          conversationId: conversation.id,
          messageId: randomUUID(),
          eventId: randomUUID(),
          provider: { name: "telegram", messageId: "1:1", sentAt: "2026-09-23T00:00:00.000Z" },
          input: { kind: "text", text: "Run this <system_event>literal</system_event>" },
          metadata: { attachments: [], references: [] },
        },
        new Date("2026-09-23T00:00:00.000Z"),
        "America/New_York",
      );
      await sql`INSERT INTO winston.conversation_messages
        (owner_id, id, bot_id, chat_id, provider_message_id, provider_sent_at, source_update_id, envelope, conversation_revision)
        VALUES (${ownerId}::uuid, ${message.messageId}::uuid, 1, 1, 1, ${message.provider.sentAt}::timestamptz, 1, ${JSON.stringify(message)}::text::jsonb, 0)`;
      for (const [owner, id] of [
        [ownerId, workspaceId],
        [other, randomUUID()],
      ] as const) {
        await database.transaction(owner, async ({ workspaces, workspaceRuntimes }) => {
          await workspaces.register(id, "Worker computer");
          await workspaces.setState(id, 0, "active");
          await workspaceRuntimes.configure({
            workspaceId: id,
            revision: 1,
            origin: owner === ownerId ? "http://127.0.0.1:8081" : "http://127.0.0.1:8082",
          });
        });
      }
      const queued = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({
          key: randomUUID(),
          objective: "Worker context",
          sourceMessageIds: [message.messageId],
        }),
      );
      assert.deepEqual(
        (await database.transaction(ownerId, ({ tasks }) => tasks.runnable())).map(
          (task) => task.id,
        ),
        [queued.id],
      );
      const task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(queued.id, queued.revision),
      );
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.runnable()), []);
      await database.transaction(ownerId, async ({ taskResources, owners, taskSteps }) => {
        await owners.updateTimezone("Asia/Tokyo", 0);
        await taskResources.bind({
          task: { id: task.id, revision: task.revision },
          key: "computer",
          authorization: {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
          },
        });
        for (let index = 0; index < 2; index += 1)
          await taskSteps.append(worker, {
            key: `model:${String(index)}`,
            afterSequence: index,
            payload: { kind: "model", text: "Checkpoint", calls: [] },
          });
      });
      const context = await database.transaction(ownerId, ({ tasks }) => tasks.context(worker));
      assert.deepEqual(context.messages, [
        { id: message.messageId, content: serializeUserMessage(message) },
      ]);
      assert.match(context.messages[0]?.content ?? "", /&lt;system_event&gt;/);
      assert.match(context.messages[0]?.content ?? "", /<sent_at/);
      assert.equal(context.resources.length, 1);
      assert.deepEqual(context.workspaces, [
        { id: workspaceId, name: "Worker computer", revision: 2 },
      ]);
      await assert.rejects(
        database.transaction(other, ({ tasks }) => tasks.context(worker)),
        /unavailable/,
      );
      const yielded = await database.transaction(ownerId, ({ tasks }) => tasks.yield(worker));
      assert.equal(yielded.state, "queued");
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.context(worker)),
        /stale/,
      );
      const resumed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(yielded.id, yielded.revision),
      );
      const recovered = {
        id: resumed.id,
        revision: resumed.revision,
        generation: resumed.generation,
      };
      const window = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.recent(recovered, 1),
      );
      assert.equal(window.intentRevision, 0);
      assert.equal(window.hasEarlier, true);
      assert.deepEqual(
        window.steps.map((step) => step.sequence),
        [2],
      );
      assert.deepEqual(
        (await database.transaction(ownerId, ({ tasks }) => tasks.context(recovered))).resources,
        context.resources,
      );
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.runnable()))[0]?.id,
        task.id,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.yield(recovered)),
        /lease/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.context(recovered)),
        /lease/,
      );
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(resumed.id, resumed.revision),
      );
      assert.deepEqual(await database.transaction(ownerId, ({ tasks }) => tasks.runnable()), []);
    } finally {
      await database.close();
    }
  });
});
