import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createFileCommands } from "@winston/server/files";
import { cliResultSchema } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";

test("exact file delivery waits for approval and resumes without duplicate sends", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const botId = 123;
    const files = createFileCommands(database, botId);
    let userId = 456;
    try {
      for (const scenario of [
        "approved",
        "recipient",
        "permission",
        "deleted",
        "rejected",
        "steered",
        "canceled",
      ] as const) {
        userId++;
        const ownerId = randomUUID();
        const workspaceId = randomUUID();
        let task = await database.transaction(
          ownerId,
          async ({ owners, workspaces, tasks, authorization }) => {
            await owners.ensure();
            await workspaces.register(workspaceId, "Approval fixture");
            await workspaces.setState(workspaceId, 0, "active");
            assert.ok(
              await authorization.put({
                target: { kind: "workspace", id: workspaceId, resource: null },
                operation: "workspace.file.read",
                decision: "ask",
                revision: 0,
              }),
            );
            const queued = await tasks.create({
              key: "send",
              objective: "Send generated file",
              sourceMessageIds: [],
            });
            return tasks.claim(queued.id, queued.revision);
          },
        );
        await sql`INSERT INTO winston.telegram_bindings(owner_id,bot_id,user_id,chat_id) VALUES (${ownerId}::uuid,${botId},${userId},${userId})`;
        const artifact = await database.transaction(ownerId, async ({ artifacts }) => {
          const prepared = await artifacts.prepare("generated", {
            name: "fixture\u2028\u202e.txt",
            mediaType: "text/plain",
            size: 3,
            sha256: createHash("sha256").update("abc").digest("hex"),
            source: {
              kind: "workspace",
              reference: `workspace:${workspaceId}/task:${task.id}/intent:0`,
            },
          });
          return artifacts.ready(prepared.artifact.id, 0);
        });
        assert.ok(artifact);
        const issue = () =>
          database.transaction(ownerId, async ({ capabilities }) => {
            const issued = await capabilities.issue({
              kind: "workspace",
              subjectId: workspaceId,
              resourceId: workspaceId,
              resourceRevision: 1,
              taskId: task.id,
              revision: task.revision,
              generation: task.generation,
              operation: "gateway:control",
              credential: null,
            });
            return {
              kind: "workspace" as const,
              subjectId: workspaceId,
              resourceId: workspaceId,
              operation: "gateway:control" as const,
              token: issued.token,
            };
          });
        let credential = await issue();
        const request = {
          version: 1 as const,
          command: "files.send" as const,
          id: artifact.id,
          key: "send",
        };
        const waiting = await files(credential, request);
        assert.equal(waiting.status, "waiting");
        assert.ok(waiting.referenceId);
        assert.equal(
          await database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.claim(botId)),
          undefined,
        );
        const actionId = waiting.referenceId;
        const approval = await database.transaction(ownerId, ({ telegramApprovals }) =>
          telegramApprovals.prepare(actionId, botId),
        );
        assert.ok(approval);
        const outbound = await sql<
          { parts: string[] }[]
        >`SELECT parts FROM winston.telegram_outbound WHERE owner_id = ${ownerId}::uuid AND id = ${approval.outboundId}::uuid`;
        assert.match(outbound[0]?.parts.join("\n") ?? "", /Send this file/);
        assert.ok(outbound[0]?.parts.join("\n").includes(artifact.id));
        assert.ok(outbound[0]?.parts.join("\n").includes("\\u2028\\u202e"));
        if (scenario === "steered" || scenario === "canceled") {
          await database.transaction(ownerId, async ({ tasks }) => {
            const paused = await tasks.find(task.id);
            assert.ok(paused);
            if (scenario === "canceled") await tasks.cancel(task.id, paused.revision);
            else {
              const queued = await tasks.steer(task.id, paused.revision, "Different request");
              task = await tasks.claim(task.id, queued.revision);
            }
          });
          if (scenario === "steered") credential = await issue();
          assert.equal((await files(credential, request)).status, "denied");
          assert.equal(
            await database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.claim(botId)),
            undefined,
          );
          continue;
        }
        await database.transaction(ownerId, async ({ actions, tasks }) => {
          const action = await actions.find(actionId);
          assert.ok(action);
          assert.ok(
            await actions.decide({
              id: action.id,
              revision: action.revision,
              hash: action.hash,
              approve: scenario !== "rejected",
            }),
          );
          const paused = await tasks.find(task.id);
          assert.ok(paused);
          const queued = await tasks.resume(task.id, paused.revision, action.id);
          task = await tasks.claim(task.id, queued.revision);
        });
        credential = await issue();
        if (scenario === "recipient")
          await sql`UPDATE winston.telegram_bindings SET chat_id = 789 WHERE owner_id = ${ownerId}::uuid`;
        if (scenario === "permission")
          await database.transaction(ownerId, ({ authorization }) =>
            authorization.put({
              target: { kind: "workspace", id: workspaceId, resource: null },
              operation: "workspace.file.read",
              decision: "deny",
              revision: 1,
            }),
          );
        if (scenario === "deleted")
          await database.transaction(ownerId, ({ artifacts }) =>
            artifacts.beginDelete(artifact.id, artifact.revision),
          );
        const result = await files(credential, request);
        if (scenario !== "approved") {
          assert.equal(result.status, "denied");
          assert.equal(
            await database.transaction(ownerId, ({ telegramFiles }) => telegramFiles.claim(botId)),
            undefined,
          );
          continue;
        }
        assert.equal(result.status, "ok");
        assert.deepEqual(await files(credential, request), result);
        const data = cliResultSchema.parse(result);
        assert.equal(data.status, "ok");
        assert.ok(data.data && typeof data.data === "object" && !Array.isArray(data.data));
        assert.ok(typeof data.data.deliveryId === "string");
        const deliveryId = data.data.deliveryId;
        assert.equal(
          (
            await database.transaction(ownerId, ({ telegramFiles }) =>
              telegramFiles.find(deliveryId),
            )
          )?.readActionId,
          actionId,
        );
        await database.transaction(ownerId, ({ tasks }) =>
          tasks.finishStep(task.id, task.revision, task.generation, {
            state: "succeeded",
            result: "File queued for delivery.",
          }),
        );
        assert.equal(
          (
            await database.transaction(ownerId, ({ telegramFiles }) =>
              telegramFiles.downloadAccess(deliveryId),
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
      }
    } finally {
      await database.close();
    }
  });
});
