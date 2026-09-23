import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import {
  createTelegramStore,
  intakeTelegramFile,
  TelegramDownloadError,
} from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("attachment intake is durable, leased, edit-safe and owner scoped", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const botId = 123;
    const telegram = createTelegramStore(connectionString, botId);
    const ownerId = randomUUID();
    const scope = <Result>(work: (scope: OwnerTransaction) => Promise<Result>) =>
      database.transaction(ownerId, work);
    const receive = async (updateId: number, fileId: string, caption: string) => {
      const message = {
        message_id: 10,
        date: 1_790_000_000,
        chat: { id: 456, type: "private" },
        from: { id: 456, is_bot: false, first_name: "Fixture" },
        caption,
        document: {
          file_id: fileId,
          file_unique_id: fileId,
          file_size: 3,
          file_name: "fixture.txt",
          mime_type: "text/plain",
        },
      };
      await telegram.receive(
        updateId === 1
          ? { update_id: updateId, message }
          : {
              update_id: updateId,
              edited_message: { ...message, edit_date: 1_790_000_000 + updateId },
            },
      );
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type IN ('telegram.message-received', 'telegram.message-edited')`;
      for (const event of events)
        await scope(({ conversations }) => conversations.consumeTelegram(event.id));
    };
    try {
      await scope(({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, 456, 456)`;
      await receive(1, "file-one", "Original caption");
      const first = (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]
        ?.envelope;
      assert.ok(first);
      const attachmentId = first.metadata.attachments[0]?.id;
      assert.ok(attachmentId);
      const saved = await scope(({ telegramIntake }) => telegramIntake.find(attachmentId));
      assert.equal(saved?.fileId, "file-one");
      assert.equal(saved.expectedSize, "3");
      assert.equal(await scope(({ telegramIntake }) => telegramIntake.discover(botId)), 0);
      const claims = await Promise.all([
        scope(({ telegramIntake }) => telegramIntake.claim(botId)),
        scope(({ telegramIntake }) => telegramIntake.claim(botId)),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const claim = claims.find(Boolean);
      assert.ok(claim);
      await receive(2, "file-one", "Use the second tab");
      assert.equal(
        (await scope(({ telegramIntake }) => telegramIntake.find(attachmentId)))?.token,
        claim.token,
      );
      const artifact = await scope(async ({ artifacts }) => {
        const prepared = await artifacts.prepare("fixture", {
          name: "fixture.txt",
          mediaType: "text/plain",
          size: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
          source: {
            kind: "telegram",
            reference: `message:${first.messageId}/attachment:${attachmentId}`,
          },
        });
        await artifacts.ready(prepared.artifact.id, 0);
        return prepared.artifact;
      });
      assert.equal(
        await scope(({ telegramIntake }) => telegramIntake.stored(claim, artifact.id)),
        true,
      );
      await receive(3, "file-two", "Replacement");
      assert.equal(
        (await scope(({ telegramIntake }) => telegramIntake.find(attachmentId)))?.state,
        "canceled",
      );
      assert.equal(
        await scope(({ telegramIntake }) => telegramIntake.stored(claim, artifact.id)),
        false,
      );
      const replacement = await scope(({ telegramIntake }) => telegramIntake.claim(botId));
      assert.ok(replacement);
      assert.notEqual(replacement.id, attachmentId);
      await sql`UPDATE winston.telegram_intake SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${replacement.id}::uuid`;
      const reclaimed = await scope(({ telegramIntake }) => telegramIntake.claim(botId));
      assert.ok(reclaimed);
      assert.notEqual(reclaimed.token, replacement.token);
      assert.equal(
        await scope(({ telegramIntake }) => telegramIntake.fail(replacement, "too_large")),
        false,
      );
      assert.equal(
        await scope(({ telegramIntake }) => telegramIntake.fail(reclaimed, "too_large")),
        true,
      );
      const failed = (await scope(({ conversations }) => conversations.snapshot(10))).messages[0];
      assert.ok(failed);
      assert.equal(failed.envelope.input.text, "Replacement");
      assert.equal(failed.envelope.metadata.attachments[0]?.state, "failed");
      assert.match(failed.content, /too large/);
      assert.deepEqual(failed.envelope.sentAt, first.sentAt);

      await receive(4, "file-three", "Another file");
      const next = (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]
        ?.envelope.metadata.attachments[0];
      assert.ok(next);
      await sql`DELETE FROM winston.telegram_intake WHERE owner_id = ${ownerId}::uuid AND id = ${next.id}::uuid`;
      assert.equal(await scope(({ telegramIntake }) => telegramIntake.discover(botId)), 1);
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(stranger, ({ telegramIntake }) => telegramIntake.find(next.id)),
        undefined,
      );
      assert.equal(
        await database.transaction(stranger, ({ telegramIntake }) => telegramIntake.claim(botId)),
        undefined,
      );
      const retry = await scope(({ telegramIntake }) => telegramIntake.claim(botId));
      assert.ok(retry);
      assert.equal(await scope(({ telegramIntake }) => telegramIntake.retry(retry)), true);
      assert.equal(await scope(({ telegramIntake }) => telegramIntake.claim(botId)), undefined);
      await sql`UPDATE winston.telegram_intake SET attempts = 5, available_at = clock_timestamp() WHERE id = ${next.id}::uuid`;
      assert.equal(await scope(({ telegramIntake }) => telegramIntake.claim(botId)), undefined);
      assert.equal(
        (await scope(({ telegramIntake }) => telegramIntake.find(next.id)))?.state,
        "failed",
      );

      await receive(5, "file-four", "Recover this upload");
      const uploads: string[] = [];
      let interrupt = true;
      const service = {
        async resumeUpload(_owner: string, id: string) {
          uploads.push(id);
          if (interrupt) {
            interrupt = false;
            throw new Error("Interrupted after object storage accepted the bytes");
          }
          return scope(async ({ artifacts }) => {
            const artifact = await artifacts.find(id);
            assert.ok(artifact);
            return artifacts.ready(id, artifact.revision);
          });
        },
      };
      const download = (id: string, _signal: AbortSignal, expected?: number) => {
        assert.equal(id, "file-four");
        assert.equal(expected, 3);
        return Promise.resolve({
          bytes: Buffer.from("abc"),
          size: 3,
          sha256: createHash("sha256").update("abc").digest("hex"),
        });
      };
      const run = () =>
        intakeTelegramFile(
          database,
          ownerId,
          botId,
          download,
          service,
          new AbortController().signal,
        );
      assert.equal(await run(), "retry");
      await sql`UPDATE winston.telegram_intake SET available_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await run(), "stored");
      assert.equal(uploads.length, 2);
      assert.equal(uploads[0], uploads[1]);
      assert.equal(await run(), "idle");
      const storedMessage = (await scope(({ conversations }) => conversations.snapshot(10)))
        .messages[0]?.envelope;
      assert.ok(storedMessage);
      // A private object is not yet a path the model can use.
      assert.equal(storedMessage.metadata.attachments[0]?.state, "pending");
      const workspaceId = randomUUID();
      await scope(async ({ workspaces, workspaceRuntimes }) => {
        await workspaces.register(workspaceId, "Fixture workspace");
        await workspaces.setState(workspaceId, 0, "active");
        await workspaceRuntimes.configure({
          workspaceId,
          revision: 1,
          origin: "http://fixture.flycast",
        });
      });
      const transfer = await scope(({ inboxTransfers }) => inboxTransfers.claim(botId));
      assert.ok(transfer);
      assert.equal(await scope(({ inboxTransfers }) => inboxTransfers.claim(botId)), null);
      assert.deepEqual(await database.authenticateInboxTransfer(transfer.token), transfer.transfer);
      assert.equal(
        await database.transaction(stranger, ({ inboxTransfers }) =>
          inboxTransfers.authenticate(transfer.token),
        ),
        null,
      );
      await sql`UPDATE winston.telegram_bindings SET chat_id = 999 WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await database.authenticateInboxTransfer(transfer.token), null);
      await sql`UPDATE winston.telegram_bindings SET chat_id = 456 WHERE owner_id = ${ownerId}::uuid`;
      await scope(({ workspaces }) => workspaces.setState(workspaceId, 2, "paused"));
      assert.equal(await database.authenticateInboxTransfer(transfer.token), null);
      await scope(({ workspaces }) => workspaces.setState(workspaceId, 3, "active"));
      assert.equal(await database.authenticateInboxTransfer(transfer.token), null);
      await sql`UPDATE winston.inbox_transfers SET expires_at = clock_timestamp() WHERE owner_id = ${ownerId}::uuid`;
      const renewed = await scope(({ inboxTransfers }) => inboxTransfers.claim(botId));
      assert.ok(renewed);
      assert.notEqual(renewed.token, transfer.token);
      assert.equal(
        await scope(({ inboxTransfers }) => inboxTransfers.complete(transfer.token)),
        false,
      );
      assert.equal(
        await scope(({ inboxTransfers }) => inboxTransfers.complete(renewed.token)),
        true,
      );
      assert.equal(
        await scope(({ inboxTransfers }) => inboxTransfers.complete(renewed.token)),
        false,
      );
      assert.equal(await database.authenticateInboxTransfer(renewed.token), null);
      const staged = (await scope(({ conversations }) => conversations.snapshot(10))).messages[0]
        ?.envelope;
      assert.equal(staged?.metadata.attachments[0]?.state, "staged");
      assert.equal(staged.input.text, "Recover this upload");
      assert.deepEqual(staged.sentAt, storedMessage.sentAt);

      await receive(6, "file-five", "Too large");
      assert.equal(
        await intakeTelegramFile(
          database,
          ownerId,
          botId,
          () => Promise.reject(new TelegramDownloadError("too_large")),
          service,
          new AbortController().signal,
        ),
        "too-large",
      );
      await receive(7, "file-six", "Replace during download");
      assert.equal(
        await intakeTelegramFile(
          database,
          ownerId,
          botId,
          async () => {
            await receive(8, "file-seven", "New attachment");
            return {
              bytes: Buffer.from("abc"),
              size: 3,
              sha256: createHash("sha256").update("abc").digest("hex"),
            };
          },
          service,
          new AbortController().signal,
        ),
        "canceled",
      );
      assert.equal(uploads.length, 2);
      assert.equal(
        await intakeTelegramFile(
          database,
          ownerId,
          botId,
          () =>
            Promise.resolve({
              bytes: Buffer.from("abc"),
              size: 3,
              sha256: createHash("sha256").update("abc").digest("hex"),
            }),
          service,
          new AbortController().signal,
        ),
        "stored",
      );
      const obsolete = await scope(({ inboxTransfers }) => inboxTransfers.claim(botId));
      assert.ok(obsolete);
      await receive(9, "file-eight", "Replace before publication");
      assert.equal(await database.authenticateInboxTransfer(obsolete.token), null);
      assert.equal(
        await scope(({ inboxTransfers }) => inboxTransfers.complete(obsolete.token)),
        false,
      );
    } finally {
      await Promise.all([database.close(), telegram.close()]);
    }
  });
});
