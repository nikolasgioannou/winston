import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { transcribeNextVoice, TranscriptionError } from "@winston/adapters/models";
import type { TelegramUpdate } from "@winston/contracts/telegram";
import { withTestPostgres } from "../../src/postgres";

test("voice leases preserve later corrections and staged files, recover and reject obsolete transcripts", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 123);
    const ownerId = randomUUID();
    const scope = <Result>(work: (scope: OwnerTransaction) => Promise<Result>) =>
      database.transaction(ownerId, work);
    const receive = async (update: TelegramUpdate) => {
      await telegram.receive(update);
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type IN ('telegram.message-received', 'telegram.message-edited')`;
      for (const event of events)
        await scope(({ conversations }) => conversations.consumeTelegram(event.id));
    };
    const base = {
      date: 1_790_000_000,
      chat: { id: 456, type: "private" as const },
      from: { id: 456, is_bot: false, first_name: "Fixture" },
    };
    const voice = async (updateId: number, fileId: string) => {
      const message = {
        ...base,
        message_id: 10,
        voice: {
          file_id: fileId,
          file_unique_id: fileId,
          file_size: 3,
          duration: 1,
          mime_type: "audio/ogg",
        },
      };
      await receive(
        updateId === 1
          ? { update_id: updateId, message }
          : {
              update_id: updateId,
              edited_message: { ...message, edit_date: base.date + updateId },
            },
      );
    };
    const store = () =>
      scope(async ({ telegramIntake, artifacts }) => {
        const intake = await telegramIntake.claim(123);
        assert.ok(intake);
        const prepared = await artifacts.prepare(`fixture:${intake.id}`, {
          name: "voice.ogg",
          mediaType: "audio/ogg",
          size: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
          source: {
            kind: "telegram",
            reference: `message:${intake.messageId}/attachment:${intake.id}`,
          },
        });
        await artifacts.ready(prepared.artifact.id, 0);
        assert.equal(await telegramIntake.stored(intake, prepared.artifact.id), true);
        return intake;
      });
    const read = async (_owner: string, id: string) => {
      const artifact = await scope(({ artifacts }) => artifacts.find(id));
      assert.ok(artifact);
      return { artifact, bytes: Buffer.from("abc") };
    };
    try {
      await scope(({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, 123, 456, 456)`;
      await voice(1, "voice-one");
      const intake = await store();
      const original = (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]
        ?.envelope;
      assert.ok(original);
      const first = await scope(({ voice }) => voice.claim(123));
      assert.ok(first);
      assert.equal(await scope(({ voice }) => voice.claim(123)), null);
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(await database.transaction(stranger, ({ voice }) => voice.active(first)), false);
      await sql`UPDATE winston.telegram_intake SET voice_leased_until = clock_timestamp() WHERE id = ${intake.id}::uuid`;
      const second = await scope(({ voice }) => voice.claim(123));
      assert.ok(second);
      assert.notEqual(second.token, first.token);
      const transcript = {
        text: "Remind me at nine.",
        provider: "openrouter",
        model: "openai/gpt-transcribe",
      };
      assert.equal(await scope(({ voice }) => voice.complete(first, transcript)), false);
      await receive({
        update_id: 2,
        message: { ...base, date: base.date + 1, message_id: 11, text: "Actually, ten." },
      });
      const attachment = original.metadata.attachments[0];
      assert.ok(attachment);
      await scope(({ conversations }) =>
        conversations.resolveMessage({
          ...original,
          revision: original.revision + 1,
          metadata: {
            ...original.metadata,
            attachments: [
              {
                ...attachment,
                state: "staged",
                artifactId: second.artifactId,
                workspaceId: randomUUID(),
                path: `/data/inbox/${second.artifactId}`,
                sha256: "a".repeat(64),
                verifiedAt: new Date().toISOString(),
              },
            ],
          },
        }),
      );
      assert.equal(await scope(({ voice }) => voice.complete(second, transcript)), true);
      const messages = (await scope(({ conversations }) => conversations.snapshot(10))).messages;
      assert.equal(messages[0]?.envelope.metadata.transcript?.state, "ready");
      assert.equal(messages[0].envelope.metadata.attachments[0]?.state, "staged");
      assert.deepEqual(messages[0].envelope.sentAt, original.sentAt);
      assert.equal(messages[1]?.envelope.input.text, "Actually, ten.");

      await voice(3, "voice-two");
      await store();
      assert.equal(
        await transcribeNextVoice(
          database,
          ownerId,
          123,
          read,
          () => Promise.reject(new TranscriptionError("unavailable")),
          new AbortController().signal,
        ),
        "retry",
      );
      assert.equal(await scope(({ voice }) => voice.claim(123)), null);
      await sql`UPDATE winston.telegram_intake SET voice_available_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(
        await transcribeNextVoice(
          database,
          ownerId,
          123,
          read,
          async () => {
            await voice(4, "voice-three");
            return transcript;
          },
          new AbortController().signal,
        ),
        "canceled",
      );
      await store();
      assert.equal(
        await transcribeNextVoice(
          database,
          ownerId,
          123,
          read,
          () => Promise.reject(new TranscriptionError("invalid_audio")),
          new AbortController().signal,
        ),
        "failed",
      );
      assert.equal(
        (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]?.envelope
          .metadata.transcript?.state,
        "failed",
      );
      await voice(5, "voice-four");
      const exhausted = await store();
      await sql`UPDATE winston.telegram_intake SET voice_attempts = 3 WHERE id = ${exhausted.id}::uuid`;
      assert.equal(await scope(({ voice }) => voice.claim(123)), null);
      assert.equal(
        (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]?.envelope
          .metadata.transcript?.state,
        "failed",
      );
    } finally {
      await Promise.all([database.close(), telegram.close()]);
    }
  });
});
