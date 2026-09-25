import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { DeviceMessage } from "@winston/contracts/devices";
import type { DeviceFileAuthority } from "@winston/contracts/device-executions";
import { withTestPostgres } from "../../src/postgres";

test("native file authority requires a reserved exact operation and rechecks all live authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      const otherOwner = randomUUID();
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      for (const operationKind of ["file.read", "file.write"] as const) {
        for (const reason of [
          "allowed",
          "policy",
          "policy-revision",
          "different-path",
          "steering",
          "cancellation",
          "worker-lease",
          "worker-generation",
          "paused",
          "capability",
          "new-session",
          "revoked",
          "deadline",
          "uncertain",
          "completed",
          "action-canceled",
          "session-lease",
        ] as const) {
          const ownerId = randomUUID();
          const prepared = await database.transaction(ownerId, async (scope) => {
            await scope.owners.ensure();
            const challenge = await scope.devices.start("File authority fixture");
            const paired = await scope.devices.pair(challenge.secret, {
              platform: "macos",
              appVersion: "0.1.0",
              protocolVersion: 1,
              capabilities: ["file.read", "file.write"],
            });
            assert.ok(paired);
            const opened = await scope.deviceSessions.open(paired.device.id, paired.credential);
            assert.ok(opened);
            const session = {
              deviceId: opened.deviceId,
              sessionId: opened.sessionId,
              generation: opened.generation,
            };
            await scope.deviceSessions.advertise(session, ["file.read", "file.write"]);
            await scope.deviceSessions.heartbeat(session, "ready");
            const queued = await scope.tasks.create({
              key: randomUUID(),
              objective: "Read or write one authorized fixture file",
              sourceMessageIds: [],
            });
            const running = await scope.tasks.claim(queued.id, queued.revision);
            const task = {
              id: running.id,
              revision: running.revision,
              generation: running.generation,
            };
            const transferId = randomUUID();
            const operation =
              operationKind === "file.read"
                ? { kind: operationKind, path: "/fixtures/report.txt", transferId }
                : {
                    kind: operationKind,
                    path: "/fixtures/report.txt",
                    transferId,
                    overwrite: false,
                    source: {
                      artifactId: randomUUID(),
                      revision: 1,
                      size: 1024,
                      sha256: "a".repeat(64),
                    },
                  };
            const action = await scope.deviceActions.prepare(
              task,
              "file",
              paired.device.id,
              operation,
            );
            assert.equal(action.state, "pending");
            await scope.actions.decide({
              id: action.id,
              revision: action.revision,
              hash: action.hash,
              approve: true,
            });
            const claim = await scope.actions.claim(action.id, action.hash, task);
            assert.ok(claim?.claimed);
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
            const proof: DeviceFileAuthority = {
              session,
              executionId: action.operationId,
              transferId,
              operation: operationKind,
            };
            return { paired, task, action, token: claim.token, message, proof };
          });
          const { paired, task, action, token, message, proof } = prepared;
          const authorize = (input = proof, deviceId = paired.device.id, owner = ownerId) =>
            database.transaction(owner, ({ actions }) =>
              actions.authorizeDeviceFileTransfer(deviceId, input),
            );
          assert.equal(
            await authorize(),
            null,
            "A claimed action without a reservation cannot authorize bytes",
          );
          const reservation = await database.transaction(ownerId, ({ deviceExecutions }) =>
            deviceExecutions.reserve({ id: action.id, token, task, message }),
          );
          assert.equal(reservation.status, "reserved");
          assert.equal((await authorize())?.actionId, action.id);
          assert.equal(await authorize({ ...proof, transferId: randomUUID() }), null);
          assert.equal(await authorize({ ...proof, executionId: randomUUID() }), null);
          assert.equal(
            await authorize({
              ...proof,
              operation: operationKind === "file.read" ? "file.write" : "file.read",
            }),
            null,
          );
          assert.equal(await authorize(proof, randomUUID()), null);
          assert.equal(await authorize(proof, paired.device.id, otherOwner), null);
          assert.equal(
            await authorize({
              ...proof,
              session: { ...proof.session, generation: proof.session.generation + 1 },
            }),
            null,
          );
          assert.equal(
            await database.transaction(ownerId, ({ actions }) =>
              actions.authorizeDevice({ id: action.id, token: "wrong", task, message }),
            ),
            false,
            "File authority does not weaken the dispatch-token requirement",
          );
          switch (reason) {
            case "allowed":
              break;
            case "policy":
            case "policy-revision":
              await database.transaction(ownerId, ({ authorization }) =>
                authorization.put({
                  target: { kind: "device", id: paired.device.id, resource: null },
                  operation: `device.${operationKind}`,
                  decision: reason === "policy" ? "deny" : "allow",
                  revision: 0,
                }),
              );
              break;
            case "different-path":
              await sql`UPDATE winston.device_executions SET document = jsonb_set(document,
                '{message,payload,operation,path}', '"/fixtures/other.txt"'::jsonb)
                WHERE owner_id = ${ownerId}::uuid`;
              break;
            case "steering":
              await database.transaction(ownerId, ({ tasks }) =>
                tasks.steer(task.id, task.revision, "Changed intent"),
              );
              break;
            case "cancellation":
              await database.transaction(ownerId, ({ tasks }) =>
                tasks.cancel(task.id, task.revision),
              );
              break;
            case "worker-lease":
              await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
              break;
            case "worker-generation":
              await sql`UPDATE winston.tasks SET document = jsonb_set(document, '{generation}', to_jsonb((document->>'generation')::integer + 1)) WHERE owner_id = ${ownerId}::uuid`;
              break;
            case "paused":
              await database.transaction(ownerId, ({ deviceSessions }) =>
                deviceSessions.heartbeat(proof.session, "paused"),
              );
              break;
            case "capability":
              await database.transaction(ownerId, ({ deviceSessions }) =>
                deviceSessions.advertise(proof.session, []),
              );
              break;
            case "new-session":
              await database.transaction(ownerId, ({ deviceSessions }) =>
                deviceSessions.open(paired.device.id, paired.credential),
              );
              break;
            case "revoked":
              await database.transaction(ownerId, ({ devices }) =>
                devices.revoke(paired.device.id, paired.device.revision),
              );
              break;
            case "deadline":
              await sql`UPDATE winston.device_executions SET deadline = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
              break;
            case "uncertain":
              await database.transaction(ownerId, ({ deviceExecutions }) =>
                deviceExecutions.requestReconciliation(action.operationId, proof.session),
              );
              break;
            case "completed":
              await database.transaction(ownerId, ({ deviceExecutions }) =>
                deviceExecutions.receipt({
                  ...message,
                  messageId: randomUUID(),
                  correlationId: message.messageId,
                  payload: {
                    kind: "status",
                    executionId: action.operationId,
                    taskId: task.id,
                    taskRevision: task.revision,
                    sequence: 0,
                    state: "succeeded",
                    exitCode: 0,
                  },
                }),
              );
              break;
            case "action-canceled":
              await sql`UPDATE winston.actions SET cancellation_requested = true WHERE owner_id = ${ownerId}::uuid`;
              break;
            case "session-lease":
              await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
              break;
          }
          const current = await authorize();
          if (reason === "allowed") assert.equal(current?.actionId, action.id);
          else assert.equal(current, null, `${operationKind}: ${reason}`);
        }
      }
    } finally {
      await database.close();
    }
  });
});
