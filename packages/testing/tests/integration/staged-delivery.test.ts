import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("staged Gmail delivery retains exact source proof after worker completion", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const botId = 123;
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", {
        test: Buffer.alloc(32, 9).toString("base64"),
      }),
    );
    try {
      await database.transaction(ownerId, async ({ owners, workspaces, workspaceRuntimes }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Delivery fixture");
        await workspaces.setState(workspaceId, 0, "active");
        await workspaceRuntimes.configure({
          workspaceId,
          revision: 1,
          origin: "http://127.0.0.1:9099",
        });
      });
      await vault.put(
        ownerId,
        accountId,
        {
          accessToken: "synthetic",
          refreshToken: "synthetic",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: [...googleScopes.gmail],
        },
        null,
      );
      const connection: Connection = {
        id: accountId,
        subject: accountId,
        service: "gmail",
        email: "owner@example.com",
        scopes: [...googleScopes.gmail],
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await sql`INSERT INTO winston.google_connections(owner_id,id,subject,service,document)
        VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'gmail',${JSON.stringify(connection)}::text::jsonb)`;
      await sql`INSERT INTO winston.telegram_bindings(owner_id,bot_id,user_id,chat_id)
        VALUES (${ownerId}::uuid,${botId},456,456)`;
      await database.transaction(ownerId, async ({ authorization }) => {
        assert.ok(
          await authorization.put({
            target: { kind: "connection", id: accountId, resource: null },
            operation: "gmail.read",
            decision: "allow",
            revision: 0,
          }),
        );
      });
      const start = () =>
        database.transaction(ownerId, async (scope) => {
          const queued = await scope.tasks.create({
            key: randomUUID(),
            objective: "Send attachment",
            sourceMessageIds: [],
          });
          const task = await scope.tasks.claim(queued.id, queued.revision);
          const worker = { id: task.id, revision: task.revision, generation: task.generation };
          const readRequest = {
            version: 1 as const,
            command: "gmail.attachment" as const,
            key: "read",
            accountId,
            id: "message1",
            partId: "",
          };
          const read = {
            action: await scope.actions.prepare({
              key: `read:${task.id}`,
              task: worker,
              authorization: {
                target: { kind: "connection", id: accountId, resource: null },
                operation: "gmail.read",
              },
              arguments: readRequest,
            }),
          };
          const claimed = await scope.actions.claim(read.action.id, read.action.hash, worker);
          assert.ok(claimed?.claimed);
          const prepared = await scope.artifacts.prepare(`gmail-attachment:${read.action.id}`, {
            name: "fixture.txt",
            mediaType: "text/plain",
            size: 3,
            sha256: createHash("sha256").update("abc").digest("hex"),
            source: {
              kind: "connection",
              reference: createHash("sha256")
                .update(JSON.stringify([accountId, "message1", ""]))
                .digest("hex"),
              origin: {
                service: "gmail",
                connectionId: accountId,
                messageId: "message1",
                partId: "",
                originalNameJson: JSON.stringify("fixture.txt"),
                readActionId: read.action.id,
              },
            },
          });
          const artifact = await scope.artifacts.ready(prepared.artifact.id, 0);
          assert.ok(artifact);
          assert.ok(
            await scope.connectedReads.complete(read.action.id, claimed.token, {
              version: 1,
              status: "ok",
              data: { artifactId: artifact.id },
            }),
          );
          const issued = await scope.capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 2,
            taskId: task.id,
            revision: task.revision,
            generation: task.generation,
            operation: "gateway:control",
            credential: null,
          });
          const credential = {
            token: issued.token,
            kind: "workspace" as const,
            subjectId: workspaceId,
            resourceId: workspaceId,
            operation: "gateway:control" as const,
          };
          return {
            task,
            artifact,
            credential,
            capabilityId: issued.id,
            input: { key: "send", botId, artifactId: artifact.id, task: worker, workspaceId },
          };
        });
      const stage = async (fixture: Awaited<ReturnType<typeof start>>) => {
        const transfer = await database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.begin(fixture.credential, {
            version: 1,
            key: "stage",
            id: fixture.artifact.id,
            revision: fixture.artifact.revision,
          }),
        );
        assert.equal(transfer.status, "transfer");
        assert.ok(
          await database.transaction(ownerId, ({ artifactTransfers }) =>
            artifactTransfers.complete(transfer.token, transfer.transfer, {
              path: `/data/inbox/${fixture.artifact.id}`,
              size: 3,
              sha256: fixture.artifact.metadata.sha256,
            }),
          ),
        );
        return transfer.transfer.transferId;
      };
      const enqueue = (fixture: Awaited<ReturnType<typeof start>>) =>
        database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.enqueue(fixture.input));
      const first = await start();
      await assert.rejects(enqueue(first), /unavailable/);
      const transferId = await stage(first);
      await assert.rejects(
        database.transaction(ownerId, ({ telegramFiles }) =>
          telegramFiles.enqueue({ ...first.input, workspaceId: randomUUID() }),
        ),
        /unavailable/,
      );
      const foreignTask = await start();
      await assert.rejects(
        database.transaction(ownerId, ({ telegramFiles }) =>
          telegramFiles.enqueue({
            ...foreignTask.input,
            artifactId: first.artifact.id,
          }),
        ),
        /unavailable/,
      );
      const delivery = await enqueue(first);
      assert.equal(delivery.transferId, transferId);
      assert.equal((await enqueue(first)).id, delivery.id);
      assert.equal(
        (await database.transaction(ownerId, ({ artifacts }) => artifacts.find(first.artifact.id)))
          ?.metadata.source.kind,
        "connection",
      );
      await database.transaction(ownerId, async ({ tasks, capabilities }) => {
        await tasks.finishStep(first.task.id, first.task.revision, first.task.generation, {
          state: "succeeded",
          result: "File queued.",
        });
        await capabilities.revoke(first.capabilityId);
      });
      assert.equal(
        (
          await database.transaction(ownerId, ({ telegramFiles }) =>
            telegramFiles.downloadAccess(delivery.id),
          )
        ).kind,
        "ready",
      );
      const claim = await database.transaction(ownerId, ({ telegramFiles }) =>
        telegramFiles.claim(botId),
      );
      assert.ok(claim);
      assert.equal(
        await database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.dispatch(claim)),
        true,
      );
      await database.transaction(ownerId, ({ telegramFiles }) =>
        telegramFiles.settle(claim, { state: "uncertain" }),
      );
      assert.equal(
        await database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.claim(botId)),
        undefined,
      );

      for (const change of ["steer", "delete", "receipt", "revoke"] as const) {
        const fixture = await start();
        const transfer = await stage(fixture);
        const queued = await enqueue(fixture);
        const pending = await database.transaction(ownerId, ({ telegramFiles }) =>
          telegramFiles.claim(botId),
        );
        assert.ok(pending);
        assert.equal(pending.id, queued.id);
        if (change === "steer")
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.steer(fixture.task.id, fixture.task.revision, "Other work"),
          );
        if (change === "delete")
          await database.transaction(ownerId, ({ artifacts }) =>
            artifacts.beginDelete(fixture.artifact.id, fixture.artifact.revision),
          );
        if (change === "receipt")
          await sql`UPDATE winston.artifact_transfers SET receipt = jsonb_set(receipt, '{sha256}', to_jsonb(${"0".repeat(64)}::text)) WHERE owner_id = ${ownerId}::uuid AND id = ${transfer}::uuid`;
        if (change === "revoke")
          await database.transaction(ownerId, ({ credentials }) =>
            credentials.revoke(accountId, 0),
          );
        assert.equal(
          await database.transaction(ownerId, ({ telegramFiles }) =>
            telegramFiles.dispatch(pending),
          ),
          false,
        );
        assert.equal(
          (
            await database.transaction(ownerId, ({ telegramFiles }) =>
              telegramFiles.downloadAccess(queued.id),
            )
          ).kind,
          "unavailable",
        );
      }
    } finally {
      await database.close();
    }
  });
});
