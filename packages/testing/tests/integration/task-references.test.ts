import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createUserMessage } from "@winston/contracts/messages";
import { withTestPostgres } from "../../src/postgres";

test("database reference checks require an owned message and its actual source tasks", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
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
          input: { kind: "text", text: "Check the selected account" },
          metadata: { attachments: [], references: [] },
        },
        new Date("2026-09-23T00:00:00.000Z"),
        "UTC",
      );
      await sql`INSERT INTO winston.conversation_messages
        (owner_id, id, bot_id, chat_id, provider_message_id, provider_sent_at, source_update_id, envelope, conversation_revision)
        VALUES (${ownerId}::uuid, ${message.messageId}::uuid, 1, 1, 1, ${message.provider.sentAt}::timestamptz, 1, ${JSON.stringify(message)}::text::jsonb, 0)`;
      const create = (owner: string, sourceMessageIds: string[]) =>
        database.transaction(owner, ({ tasks }) =>
          tasks.create({ key: randomUUID(), objective: "Reference fixture", sourceMessageIds }),
        );
      const related = await create(ownerId, [message.messageId]);
      const unrelated = await create(ownerId, []);
      const foreign = await create(other, []);
      const validate = (ids: string[], owner = ownerId, messageId = message.messageId) =>
        database.transaction(owner, ({ taskResources }) =>
          taskResources.validateReferences(messageId, ids),
        );
      await validate([related.id]);
      await validate([]);
      await assert.rejects(validate([unrelated.id]), /unrelated/);
      await assert.rejects(validate([foreign.id]), /unavailable/);
      await assert.rejects(validate([randomUUID()]), /unavailable/);
      await assert.rejects(validate([related.id, related.id]), /unique/);
      await assert.rejects(validate([related.id], other), /owner/);
      await assert.rejects(validate([], ownerId, randomUUID()), /owner/);
      const stored = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(1),
      );
      assert.deepEqual(
        stored.messages[0]?.envelope,
        message,
        "validation must not rewrite or forward message metadata",
      );
      const revised = {
        ...message,
        revision: 1,
        metadata: { ...message.metadata, references: [{ kind: "task" as const, id: related.id }] },
      };
      await database.transaction(ownerId, ({ conversations }) =>
        conversations.resolveMessage(revised),
      );
      const resolved = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(1),
      );
      assert.deepEqual(resolved.messages[0]?.envelope.input, message.input);
      assert.deepEqual(resolved.messages[0].envelope.sentAt, message.sentAt);
      assert.match(resolved.messages[0].content, new RegExp(related.id));
      await assert.rejects(
        database.transaction(ownerId, ({ conversations }) =>
          conversations.resolveMessage({
            ...revised,
            revision: 2,
            metadata: { ...message.metadata, references: [{ kind: "task", id: unrelated.id }] },
          }),
        ),
        /unrelated/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ conversations }) =>
          conversations.resolveMessage({
            ...revised,
            revision: 2,
            input: { ...message.input, text: "rewritten" },
          }),
        ),
        /receipt/,
      );

      const workspaceId = randomUUID();
      const binding = await database.transaction(ownerId, async ({ workspaces, taskResources }) => {
        await workspaces.register(workspaceId, "Reference fixture");
        await workspaces.setState(workspaceId, 0, "active");
        return taskResources.bind({
          task: { id: related.id, revision: related.revision },
          key: "workspace",
          authorization: {
            operation: "workspace.command",
            target: { kind: "workspace", id: workspaceId, resource: null },
          },
        });
      });
      // Removing the source from the rolling window must not remove task context.
      await sql`DELETE FROM winston.conversation_messages WHERE owner_id = ${ownerId}::uuid`;
      const emptyWindow = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(1),
      );
      assert.equal(emptyWindow.messages.length, 0);
      assert.deepEqual(emptyWindow.taskResources, { bindings: [binding], truncated: false });
      assert.deepEqual(
        await database.transaction(other, ({ taskResources }) =>
          taskResources.context([related.id]),
        ),
        {
          bindings: [],
          truncated: false,
        },
      );
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(related.id, related.revision, "Use a new target"),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ taskResources }) =>
          taskResources.context([related.id]),
        ),
        {
          bindings: [],
          truncated: false,
        },
      );
      await database.transaction(ownerId, async ({ taskResources, tasks }) => {
        const current = await tasks.find(related.id);
        assert.ok(current);
        for (let index = 0; index < 100; index += 1) {
          await taskResources.bind({
            task: { id: current.id, revision: current.revision },
            key: `resource:${String(index)}`,
            authorization: binding.authorization,
          });
        }
        await taskResources.bind({
          task: { id: unrelated.id, revision: unrelated.revision },
          key: "overflow",
          authorization: binding.authorization,
        });
        const context = await taskResources.context([related.id, unrelated.id]);
        assert.equal(context.bindings.length, 100);
        assert.equal(context.truncated, true);
        assert.equal(
          (await taskResources.list({ id: current.id, revision: current.revision })).length,
          100,
        );
      });
    } finally {
      await database.close();
    }
  });
});
