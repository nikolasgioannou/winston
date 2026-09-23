import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";
import { createFileCommands } from "@winston/server/files";

test("file delivery receipts bind task intent and never retry ambiguous dispatch", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const botId = 123;
    const scope = <Result>(work: (scope: OwnerTransaction) => Promise<Result>) =>
      database.transaction(ownerId, work);
    try {
      await scope(({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, 456, 456)`;
      await scope(async ({ workspaces }) => {
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      const start = () =>
        scope(async ({ tasks, artifacts, telegramFiles }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Send file",
            sourceMessageIds: [],
          });
          const task = await tasks.claim(queued.id, queued.revision);
          const prepared = await artifacts.prepare(randomUUID(), {
            name: "fixture.txt",
            mediaType: "text/plain",
            size: 3,
            sha256: createHash("sha256").update("abc").digest("hex"),
            source: {
              kind: "workspace",
              reference: `workspace:${workspaceId}/task:${task.id}/intent:0`,
            },
          });
          await artifacts.ready(prepared.artifact.id, 0);
          const input = {
            key: "file",
            botId,
            artifactId: prepared.artifact.id,
            task: { id: task.id, revision: task.revision, generation: task.generation },
            workspaceId,
          };
          return { task, input, delivery: await telegramFiles.enqueue(input) };
        });
      const first = await start();
      const files = createFileCommands(database, botId);
      const authority = await scope(({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: first.task.id,
          revision: first.task.revision,
          generation: first.task.generation,
          operation: "gateway:control",
          credential: null,
        }),
      );
      const credential = {
        token: authority.token,
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:control" as const,
      };
      const queuedResult = await files(credential, {
        version: 1,
        command: "files.send",
        id: first.input.artifactId,
        key: "file",
      });
      assert.equal(queuedResult.status, "ok");
      assert.deepEqual(queuedResult.data, {
        deliveryId: first.delivery.id,
        artifactId: first.input.artifactId,
        state: "pending",
        messageId: null,
      });
      assert.equal(
        (
          await files(
            { ...credential, operation: "gateway:read" },
            {
              version: 1,
              command: "files.send",
              id: first.input.artifactId,
              key: "other",
            },
          )
        ).status,
        "denied",
      );
      assert.equal(
        (await scope(({ telegramFiles }) => telegramFiles.enqueue(first.input))).id,
        first.delivery.id,
      );
      await assert.rejects(
        scope(({ telegramFiles }) =>
          telegramFiles.enqueue({ ...first.input, artifactId: randomUUID() }),
        ),
        /conflicts/,
      );
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(stranger, ({ telegramFiles }) =>
          telegramFiles.find(first.delivery.id),
        ),
        undefined,
      );
      const [one, two] = await Promise.all([
        scope(({ telegramFiles }) => telegramFiles.claim(botId)),
        scope(({ telegramFiles }) => telegramFiles.claim(botId)),
      ]);
      const claim = one ?? two;
      assert.ok(claim);
      assert.equal(Boolean(one) && Boolean(two), false);
      assert.equal(
        await scope(({ telegramFiles }) =>
          telegramFiles.settle(claim, { state: "sent", messageId: 12 }),
        ),
        false,
      );
      await sql`UPDATE winston.telegram_files SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${claim.id}::uuid`;
      const reclaimed = await scope(({ telegramFiles }) => telegramFiles.claim(botId));
      assert.ok(reclaimed);
      assert.notEqual(reclaimed.token, claim.token);
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.dispatch(claim)), false);
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.dispatch(reclaimed)), true);
      await sql`UPDATE winston.telegram_files SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${claim.id}::uuid`;
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.claim(botId)), undefined);
      assert.equal(
        (await scope(({ telegramFiles }) => telegramFiles.find(claim.id)))?.state,
        "uncertain",
      );
      await scope(({ telegramOutbound }) =>
        telegramOutbound.enqueue("chat", botId, "Still responsive"),
      );
      assert.ok(await scope(({ telegramOutbound }) => telegramOutbound.claim(botId)));
      assert.equal(
        await scope(({ telegramFiles }) =>
          telegramFiles.settle(reclaimed, { state: "sent", messageId: 12 }),
        ),
        true,
      );

      const steered = await start();
      const pending = await scope(({ telegramFiles }) => telegramFiles.claim(botId));
      assert.ok(pending);
      await scope(({ tasks }) =>
        tasks.steer(steered.task.id, steered.task.revision, "Different request"),
      );
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.dispatch(pending)), false);
      assert.equal(
        (await scope(({ telegramFiles }) => telegramFiles.find(pending.id)))?.state,
        "canceled",
      );

      const canceled = await start();
      await scope(({ tasks }) => tasks.cancel(canceled.task.id, canceled.task.revision));
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.claim(botId)), undefined);
      const deleted = await start();
      await scope(({ artifacts }) => artifacts.beginDelete(deleted.input.artifactId, 1));
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.claim(botId)), undefined);

      const changedPermission = await start();
      const permissionClaim = await scope(({ telegramFiles }) => telegramFiles.claim(botId));
      assert.ok(permissionClaim);
      assert.equal(permissionClaim.id, changedPermission.delivery.id);
      await scope(({ authorization }) =>
        authorization.put({
          revision: 0,
          operation: "workspace.file.read",
          decision: "deny",
          target: { kind: "workspace", id: workspaceId, resource: null },
        }),
      );
      assert.equal(
        await scope(({ telegramFiles }) => telegramFiles.dispatch(permissionClaim)),
        false,
      );
      await scope(({ authorization }) =>
        authorization.put({
          revision: 1,
          operation: "workspace.file.read",
          decision: "allow",
          target: { kind: "workspace", id: workspaceId, resource: null },
        }),
      );

      const retry = await start();
      await scope(({ tasks }) =>
        tasks.finishStep(retry.task.id, retry.task.revision, retry.task.generation, {
          state: "succeeded",
          result: "File queued for delivery.",
        }),
      );
      const retryClaim = await scope(({ telegramFiles }) => telegramFiles.claim(botId));
      assert.ok(retryClaim);
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.dispatch(retryClaim)), true);
      await scope(({ telegramFiles }) =>
        telegramFiles.settle(retryClaim, { state: "retry", afterSeconds: 10 }),
      );
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.claim(botId)), undefined);
      await sql`UPDATE winston.telegram_files SET available_at = clock_timestamp() WHERE id = ${retry.delivery.id}::uuid`;
      const finalClaim = await scope(({ telegramFiles }) => telegramFiles.claim(botId));
      assert.ok(finalClaim);
      await sql`DELETE FROM winston.telegram_bindings WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await scope(({ telegramFiles }) => telegramFiles.dispatch(finalClaim)), false);
    } finally {
      await database.close();
    }
  });
});
