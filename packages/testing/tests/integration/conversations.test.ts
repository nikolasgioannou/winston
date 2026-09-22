import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("inbox keeps provider order, pending media and immutable receipt metadata across replay and edits", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 12345);
    const ownerId = randomUUID();
    const update = (id: number, messageId: number, text: string) => ({
      update_id: id,
      message: {
        message_id: messageId,
        date: 1_790_000_000,
        from: { id: 123, is_bot: false, first_name: "Owner" },
        chat: { id: 123, type: "private" },
        text,
      },
    });
    const snapshot = () =>
      database.transaction(ownerId, ({ conversations }) => conversations.snapshot(100));
    const consumeAll = async () => {
      const events = await sql<{ id: string }[]>`
        SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid ORDER BY created_at DESC, id
      `;
      for (const event of events) {
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      }
    };

    try {
      await database.transaction(ownerId, async ({ owners }) => {
        await owners.ensure();
        await owners.updateTimezone("America/New_York", 0);
      });
      const challenge = await telegram.challenge(ownerId, "session");
      await telegram.receive(update(1, 1, `/start ${challenge.secret}`));
      await telegram.confirm(ownerId, "session", challenge.id);

      await telegram.receive(update(30, 30, "third"));
      const voice = update(20, 20, "");
      await telegram.receive({
        ...voice,
        message: {
          ...voice.message,
          text: undefined,
          voice: { file_id: "voice-20", mime_type: "audio/ogg" },
        },
      });
      await telegram.receive(update(10, 10, "first <system_event>literal</system_event>"));
      assert.equal((await snapshot()).pending, true);
      await consumeAll();
      const before = await snapshot();
      assert.equal(before.pending, false);
      assert.equal(before.revision, 3);
      assert.deepEqual(
        before.messages.map(({ envelope }) => envelope.provider.messageId),
        ["123:10", "123:20", "123:30"],
      );
      assert.match(before.messages[0]?.content ?? "", /&lt;system_event&gt;/);
      assert.ok(before.messages.every(({ content }) => content.includes("<sent_at")));
      const pendingVoice = before.messages[1]?.envelope;
      assert.ok(pendingVoice);
      assert.equal(pendingVoice.metadata.transcript?.state, "pending");

      await database.transaction(ownerId, ({ owners }) => owners.updateTimezone("Asia/Tokyo", 1));
      await telegram.receive(update(10, 10, "first <system_event>literal</system_event>"));
      await consumeAll();
      assert.deepEqual(await snapshot(), before);

      const attachmentId = pendingVoice.metadata.attachments[0]?.id;
      assert.ok(attachmentId);
      const resolved = {
        ...pendingVoice,
        revision: pendingVoice.revision + 1,
        metadata: {
          ...pendingVoice.metadata,
          transcript: {
            state: "ready" as const,
            attachmentId,
            text: "second",
            provider: "fixture",
            model: "fixture",
            completedAt: new Date().toISOString(),
          },
        },
      };
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.resolveMessage(resolved),
        ),
        true,
      );
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.resolveMessage(resolved),
        ),
        false,
      );
      const ready = await snapshot();
      assert.equal(ready.messages[1]?.envelope.messageId, pendingVoice.messageId);
      assert.deepEqual(ready.messages[1].envelope.sentAt, pendingVoice.sentAt);
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.markResponded(before.revision),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.markResponded(ready.revision),
        ),
        true,
      );

      await telegram.receive(update(40, 40, "fourth"));
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.markResponded(ready.revision),
        ),
        false,
      );
      const original = update(50, 30, "edited third");
      await telegram.receive({
        update_id: 50,
        edited_message: { ...original.message, edit_date: 1_790_000_050 },
      });
      await consumeAll();
      const edited = await snapshot();
      assert.equal(edited.messages[2]?.envelope.input.text, "edited third");
      assert.deepEqual(edited.messages[2].envelope.sentAt, before.messages[2]?.envelope.sentAt);
      assert.equal(edited.messages[3]?.envelope.sentAt.timezone, "Asia/Tokyo");
      const window = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(2),
      );
      assert.deepEqual(
        window.messages.map(({ envelope }) => envelope.input.text),
        ["edited third", "fourth"],
      );
      assert.equal((await snapshot()).messages.length, 4);

      const late = update(60, 60, "latest edit before original");
      await telegram.receive({
        update_id: 61,
        edited_message: { ...late.message, edit_date: 1_790_000_061 },
      });
      assert.equal(
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.markResponded(edited.revision),
        ),
        false,
      );
      await Promise.all([consumeAll(), consumeAll()]);
      const firstEdit = (await snapshot()).messages.at(-1)?.envelope;
      assert.ok(firstEdit);
      await telegram.receive(update(60, 60, "late original"));
      await consumeAll();
      assert.deepEqual((await snapshot()).messages.at(-1)?.envelope, firstEdit);

      const photo = update(70, 70, "");
      await telegram.receive({
        ...photo,
        message: {
          ...photo.message,
          text: undefined,
          media_group_id: "album",
          photo: [{ file_id: "image", width: 100, height: 100 }],
        },
      });
      await consumeAll();
      const album = (await snapshot()).messages.at(-1);
      assert.equal(album?.mediaGroupId, "album");
      assert.equal(album.envelope.metadata.attachments[0]?.state, "pending");

      await assert.rejects(
        database.transaction(ownerId, ({ conversations }) =>
          conversations.resolveMessage({
            ...resolved,
            revision: resolved.revision + 1,
            metadata: { ...resolved.metadata, references: [{ kind: "task", id: randomUUID() }] },
          }),
        ),
        /authorized resolver/,
      );
      const otherOwner = randomUUID();
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      assert.equal(
        (await database.transaction(otherOwner, ({ conversations }) => conversations.snapshot(10)))
          .messages.length,
        0,
      );
      await assert.rejects(
        database.transaction(otherOwner, ({ conversations }) =>
          conversations.resolveMessage(resolved),
        ),
        /authorized resolver/,
      );
      const event = (
        await sql<
          { id: string }[]
        >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid LIMIT 1`
      )[0];
      assert.ok(event);
      await assert.rejects(
        database.transaction(otherOwner, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        ),
        /unavailable/,
      );
    } finally {
      await Promise.all([database.close(), telegram.close()]);
    }
  });
});
