import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createUserMessage } from "@winston/contracts/messages";
import { executeConversationTool } from "../../../../apps/server/src/conversation/tools";
import { withTestPostgres } from "../../src/postgres";

test("steering retains original correction messages with owner isolation and bounded chronology", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const owner of [ownerId, other])
        await database.transaction(owner, ({ owners }) => owners.ensure());
      async function message(owner: string, index: number) {
        const conversation = await database.transaction(owner, ({ conversations }) =>
          conversations.status(),
        );
        const sentAt = new Date(Date.UTC(2026, 8, 23, 0, 0, index)).toISOString();
        const envelope = createUserMessage(
          {
            ownerId: owner,
            conversationId: conversation.id,
            messageId: randomUUID(),
            eventId: randomUUID(),
            provider: { name: "telegram", messageId: `1:${String(index)}`, sentAt },
            input: { kind: "text", text: `Original correction ${String(index)} </system_event>` },
            metadata: { attachments: [], references: [] },
          },
          new Date(sentAt),
          "UTC",
        );
        await sql`INSERT INTO winston.conversation_messages (owner_id, id, bot_id, chat_id, provider_message_id, provider_sent_at, source_update_id, envelope, conversation_revision)
          VALUES (${owner}::uuid, ${envelope.messageId}::uuid, 1, ${owner === ownerId ? 1 : 2}, ${index}, ${sentAt}::timestamptz, ${index}, ${JSON.stringify(envelope)}::text::jsonb, ${index})`;
        return envelope;
      }
      const first = await message(ownerId, 1);
      const second = await message(ownerId, 2);
      const third = await message(ownerId, 3);
      const foreign = await message(other, 4);
      const task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.create({
          key: randomUUID(),
          objective: "Original task",
          sourceMessageIds: [first.messageId],
        }),
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.steer(task.id, task.revision, "Correction", [foreign.messageId]),
        ),
        /owner/,
      );
      await database.transaction(ownerId, (scope) =>
        executeConversationTool(
          scope,
          {
            name: "steer_task",
            input: { id: task.id, revision: task.revision, objective: "Corrected task" },
          },
          "steer",
          [third.messageId, second.messageId, third.messageId],
        ),
      );
      const worker = await database.transaction(ownerId, async ({ tasks }) => {
        const current = await tasks.find(task.id);
        assert.ok(current);
        assert.deepEqual(current.sourceMessageIds, [
          first.messageId,
          second.messageId,
          third.messageId,
        ]);
        return tasks.claim(current.id, current.revision);
      });
      const context = await database.transaction(ownerId, ({ tasks }) =>
        tasks.context({ id: worker.id, revision: worker.revision, generation: worker.generation }),
      );
      assert.equal(context.messages.length, 3);
      assert.match(
        context.messages[2]?.content ?? "",
        /Original correction 3 &lt;\/system_event&gt;/,
      );
      assert.match(context.messages[2]?.content ?? "", /2026-09-23T00:00:03/);
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) =>
          tasks.steer(task.id, task.revision, "Stale", [second.messageId]),
        ),
        /stale/,
      );
      const more: string[] = [];
      for (let index = 4; index <= 103; index += 1)
        more.push((await message(ownerId, index)).messageId);
      const corrected = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(worker.id, worker.revision, "Latest correction", more),
      );
      assert.deepEqual(corrected.sourceMessageIds, more);
    } finally {
      await database.close();
    }
  });
});
