import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService, createDeviceFileReceiver } from "@winston/adapters/artifacts";
import { MissingStoredObject } from "@winston/adapters/storage";
import type { DeviceMessage } from "@winston/contracts/devices";
import { withTestPostgres } from "../../src/postgres";

test("captured device files retain read authority through staging and completed-task delivery", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({
      connectionString,
      onConnectionError: () => {},
    });
    const objects = new Set<string>();
    const content = Buffer.from("native fixture");
    const digest = createHash("sha256").update(content).digest("hex");
    const artifacts = createArtifactService(database, {
      async upload(ownerId, source, object) {
        assert.ok(object.id);
        const chunks: Uint8Array[] = [];
        for await (const chunk of source) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), content);
        objects.add(object.id);
        return { ...object, id: object.id, ownerId };
      },
      verify(_ownerId, object) {
        return objects.has(object.id)
          ? Promise.resolve(true)
          : Promise.reject(new MissingStoredObject());
      },
      downloadUrl: () => {
        throw new Error("No external download");
      },
      remove: () => {
        throw new Error("No external deletion");
      },
    });
    const receive = createDeviceFileReceiver({ database, artifacts });
    let fixtureNumber = 0;
    const fixture = async () => {
      fixtureNumber += 1;
      const botId = fixtureNumber;
      const ownerId = randomUUID();
      const workspaceId = randomUUID();
      const initialized = await database.transaction(ownerId, async (scope) => {
        await scope.owners.ensure();
        await scope.workspaces.register(workspaceId, "Native staging fixture");
        await scope.workspaces.setState(workspaceId, 0, "active");
        await scope.workspaceRuntimes.configure({
          workspaceId,
          revision: 1,
          origin: `http://127.0.0.1:${String(9099 + fixtureNumber)}`,
        });
        const challenge = await scope.devices.start("Fixture Mac");
        const paired = await scope.devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["file.read"],
        });
        assert.ok(paired);
        const opened = await scope.deviceSessions.open(paired.device.id, paired.credential);
        assert.ok(opened);
        const session = {
          deviceId: opened.deviceId,
          sessionId: opened.sessionId,
          generation: opened.generation,
        };
        await scope.deviceSessions.advertise(session, ["file.read"]);
        await scope.deviceSessions.heartbeat(session, "ready");
        const queued = await scope.tasks.create({
          key: randomUUID(),
          objective: "Send native file",
          sourceMessageIds: [],
        });
        const running = await scope.tasks.claim(queued.id, queued.revision);
        const task = {
          id: running.id,
          revision: running.revision,
          generation: running.generation,
        };
        const operation = {
          kind: "file.read" as const,
          path: "/fixtures/report.txt",
          transferId: randomUUID(),
        };
        const action = await scope.deviceActions.prepare(
          task,
          "capture",
          paired.device.id,
          operation,
        );
        await scope.actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        });
        const message: DeviceMessage = {
          version: 1,
          messageId: randomUUID(),
          correlationId: randomUUID(),
          ...session,
          payload: {
            kind: "execute",
            executionId: action.operationId,
            taskId: task.id,
            taskRevision: task.revision,
            deadline: Date.now() + 60_000,
            operation,
          },
        };
        const reserved = await scope.deviceExecutions.reserveApproved({
          id: action.id,
          hash: action.hash,
          task,
          message,
        });
        assert.equal(reserved.status, "reserved");
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
        return {
          paired,
          session,
          task,
          operation,
          action,
          message,
          credential: {
            token: issued.token,
            kind: "workspace" as const,
            subjectId: workspaceId,
            resourceId: workspaceId,
            operation: "gateway:control" as const,
          },
        };
      });
      const uploaded = await receive(
        ownerId,
        initialized.paired.device.id,
        {
          version: 1,
          authority: {
            session: initialized.session,
            executionId: initialized.action.operationId,
            transferId: initialized.operation.transferId,
            operation: "file.read",
          },
          size: content.length,
          sha256: digest,
        },
        [content],
        new AbortController().signal,
      );
      assert.equal(uploaded.status, "ready");
      assert.ok("artifactId" in uploaded);
      const complete = () =>
        database.transaction(ownerId, async (scope) => {
          await scope.deviceExecutions.receipt({
            ...initialized.message,
            messageId: randomUUID(),
            correlationId: initialized.message.messageId,
            payload: {
              kind: "status",
              executionId: initialized.action.operationId,
              taskId: initialized.task.id,
              taskRevision: initialized.task.revision,
              sequence: 0,
              state: "succeeded",
              exitCode: 0,
            },
          });
          assert.equal(
            (await scope.actions.reconcileDevice(initialized.action.operationId))?.state,
            "succeeded",
          );
          await scope.deviceSessions.close(initialized.session);
        });
      await sql`INSERT INTO winston.telegram_bindings(owner_id,bot_id,user_id,chat_id) VALUES (${ownerId}::uuid,${botId},123,123)`;
      const begin = () =>
        database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.begin(initialized.credential, {
            version: 1,
            key: "stage",
            id: uploaded.artifactId,
            revision: uploaded.revision,
          }),
        );
      const send = () =>
        database.transaction(ownerId, ({ telegramFiles }) =>
          telegramFiles.enqueue({
            key: "send",
            botId,
            artifactId: uploaded.artifactId,
            task: initialized.task,
            workspaceId,
          }),
        );
      return {
        ...initialized,
        ownerId,
        uploaded,
        botId,
        complete,
        begin,
        send,
      };
    };
    try {
      const first = await fixture();
      assert.notEqual(
        (await first.begin()).status,
        "transfer",
        "Intake alone is not a completed native read",
      );
      await first.complete();
      const transfer = await first.begin();
      assert.equal(transfer.status, "transfer");
      await database.transaction(first.ownerId, ({ artifactTransfers }) =>
        artifactTransfers.complete(transfer.token, transfer.transfer, {
          path: `/data/inbox/${first.uploaded.artifactId}`,
          size: content.length,
          sha256: digest,
        }),
      );
      const queued = await first.send();
      await database.transaction(first.ownerId, ({ tasks }) =>
        tasks.finishStep(first.task.id, first.task.revision, first.task.generation, {
          state: "succeeded",
          result: "File queued",
        }),
      );
      assert.equal(
        (
          await database.transaction(first.ownerId, ({ telegramFiles }) =>
            telegramFiles.downloadAccess(queued.id),
          )
        ).kind,
        "ready",
      );
      const claim = await database.transaction(first.ownerId, ({ telegramFiles }) =>
        telegramFiles.claim(first.botId),
      );
      assert.ok(claim);
      assert.equal(
        await database.transaction(first.ownerId, ({ telegramFiles }) =>
          telegramFiles.dispatch(claim),
        ),
        true,
      );
      await database.transaction(first.ownerId, ({ telegramFiles }) =>
        telegramFiles.settle(claim, { state: "uncertain" }),
      );
      assert.equal(
        await database.transaction(first.ownerId, ({ telegramFiles }) =>
          telegramFiles.claim(first.botId),
        ),
        undefined,
      );

      for (const change of ["revoke", "policy", "steer", "path", "execution", "delete"] as const) {
        const f = await fixture();
        await f.complete();
        const stage = await f.begin();
        assert.equal(stage.status, "transfer");
        await database.transaction(f.ownerId, ({ artifactTransfers }) =>
          artifactTransfers.complete(stage.token, stage.transfer, {
            path: `/data/inbox/${f.uploaded.artifactId}`,
            size: content.length,
            sha256: digest,
          }),
        );
        const delivery = await f.send();
        const pending = await database.transaction(f.ownerId, ({ telegramFiles }) =>
          telegramFiles.claim(f.botId),
        );
        assert.ok(pending);
        if (change === "steer")
          await database.transaction(f.ownerId, ({ tasks }) =>
            tasks.steer(f.task.id, f.task.revision, "Do something else"),
          );
        if (change === "revoke")
          await database.transaction(f.ownerId, ({ devices }) =>
            devices.revoke(f.paired.device.id, f.paired.device.revision),
          );
        if (change === "policy")
          await database.transaction(f.ownerId, async ({ authorization }) => {
            const current = await authorization.list();
            assert.ok(
              await authorization.put({
                target: { kind: "device", id: f.paired.device.id, resource: null },
                operation: "device.file.read",
                decision: "deny",
                revision: current.revision,
              }),
            );
          });
        if (change === "path")
          await sql`UPDATE winston.artifacts SET document = jsonb_set(document, '{metadata,source,origin,path}', '"/other.txt"'::jsonb) WHERE owner_id = ${f.ownerId}::uuid AND id = ${f.uploaded.artifactId}::uuid`;
        if (change === "execution")
          await sql`UPDATE winston.device_executions SET state = 'failed' WHERE owner_id = ${f.ownerId}::uuid AND execution_id = ${f.action.operationId}::uuid`;
        if (change === "delete")
          await database.transaction(f.ownerId, ({ artifacts: records }) =>
            records.beginDelete(f.uploaded.artifactId, f.uploaded.revision),
          );
        assert.equal(
          await database.transaction(f.ownerId, ({ telegramFiles }) =>
            telegramFiles.dispatch(pending),
          ),
          false,
          change,
        );
        assert.equal((await f.begin()).status, "denied", change);
        assert.equal(
          (
            await database.transaction(f.ownerId, ({ telegramFiles }) =>
              telegramFiles.downloadAccess(delivery.id),
            )
          ).kind,
          "unavailable",
          change,
        );
      }
    } finally {
      await database.close();
    }
  });
});
