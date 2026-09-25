import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import {
  createDatabase,
  migrateDatabase,
  DeviceActionPreparationError,
  DeviceReservationError,
} from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";
import { deviceWriteFixture } from "./device-write-fixture";

test("native writes pin their source through approval and reject unbound or substituted operations", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      for (const kind of ["workspace", "device"] as const) {
        const f = await deviceWriteFixture(database, kind === "workspace" ? 11001 : 11002, kind);
        assert.equal(await f.access(), null);
        const other = await f.anotherArtifact();
        await assert.rejects(
          database.transaction(f.ownerId, ({ deviceFileWrites }) =>
            deviceFileWrites.prepare(f.credential, {
              ...f.request,
              artifactId: other.id,
              revision: other.revision,
            }),
          ),
          (error: unknown) =>
            error instanceof DeviceActionPreparationError && error.reason === "conflict",
        );
        for (const change of [
          { path: "/fixtures/other.txt" },
          { overwrite: true },
          { id: randomUUID() },
        ]) {
          await assert.rejects(
            database.transaction(f.ownerId, ({ deviceFileWrites }) =>
              deviceFileWrites.prepare(f.credential, { ...f.request, ...change }),
            ),
            (error: unknown) =>
              error instanceof DeviceActionPreparationError && error.reason === "conflict",
          );
        }
        const generic = await database.transaction(f.ownerId, async (scope) => {
          const operation = { ...f.operation, transferId: randomUUID() };
          const action = await scope.deviceActions.prepare(
            f.worker,
            "unbound",
            f.session.deviceId,
            operation,
          );
          await scope.actions.decide({
            id: action.id,
            revision: action.revision,
            hash: action.hash,
            approve: true,
          });
          return { action, operation };
        });
        assert.ok(f.message.payload.kind === "execute");
        const original = f.message.payload;
        await assert.rejects(
          database.transaction(f.ownerId, ({ deviceExecutions }) =>
            deviceExecutions.reserveApproved({
              id: generic.action.id,
              hash: generic.action.hash,
              task: f.worker,
              message: {
                ...f.message,
                messageId: randomUUID(),
                payload: {
                  ...original,
                  executionId: generic.action.operationId,
                  operation: generic.operation,
                },
              },
            }),
          ),
          (error: unknown) => error instanceof DeviceReservationError && error.status === "denied",
        );
        assert.equal((await f.reserve()).status, "reserved");
        const access = await f.access();
        assert.ok(access);
        assert.equal(access.artifact.id, f.artifact.id);
        assert.equal(access.artifact.revision, f.artifact.revision);
        assert.equal(access.artifact.metadata.sha256, f.operation.source.sha256);
        assert.equal(
          await database.transaction(f.ownerId, ({ deviceFileWrites }) =>
            deviceFileWrites.authorize(randomUUID(), f.authority),
          ),
          null,
        );
        assert.equal(
          await database.transaction(f.ownerId, ({ deviceFileWrites }) =>
            deviceFileWrites.authorize(f.session.deviceId, {
              ...f.authority,
              transferId: randomUUID(),
            }),
          ),
          null,
        );
      }
    } finally {
      await database.close();
    }
  });
}, 120_000);

test("native write source authority is checked again after dispatch", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    try {
      let port = 11100;
      for (const change of [
        "deleted",
        "workspace",
        "source-policy",
        "steered",
        "canceled",
        "unbound",
        "publication",
        "metadata",
        "staging",
        "source-read",
      ] as const) {
        const staged = change === "staging" || change === "source-read";
        const f = await deviceWriteFixture(database, ++port, staged ? "device" : "workspace");
        assert.equal((await f.reserve()).status, "reserved");
        assert.ok(await f.access());
        if (change === "deleted")
          await database.transaction(f.ownerId, ({ artifacts }) =>
            artifacts.beginDelete(f.artifact.id, f.artifact.revision),
          );
        if (change === "workspace")
          await database.transaction(f.ownerId, ({ workspaces }) =>
            workspaces.setState(f.workspaceId, 2, "paused"),
          );
        if (change === "source-policy")
          await database.transaction(f.ownerId, async ({ authorization }) => {
            const policy = await authorization.list();
            assert.ok(
              await authorization.put({
                target: { kind: "workspace", id: f.workspaceId, resource: null },
                operation: "workspace.file.read",
                decision: "deny",
                revision: policy.revision,
              }),
            );
          });
        if (change === "steered")
          await database.transaction(f.ownerId, ({ tasks }) =>
            tasks.steer(f.worker.id, f.worker.revision, "Different request"),
          );
        if (change === "canceled")
          await database.transaction(f.ownerId, ({ tasks }) =>
            tasks.cancel(f.worker.id, f.worker.revision),
          );
        if (change === "unbound")
          await sql`DELETE FROM winston.device_file_writes WHERE owner_id = ${f.ownerId}::uuid AND action_id = ${f.prepared.action.id}::uuid`;
        if (change === "publication")
          await sql`UPDATE winston.actions SET document = jsonb_set(document, '{state}', '"unknown"'::jsonb) WHERE owner_id = ${f.ownerId}::uuid AND id = (SELECT source_action_id FROM winston.device_file_writes WHERE owner_id = ${f.ownerId}::uuid AND action_id = ${f.prepared.action.id}::uuid)`;
        if (change === "metadata")
          await sql`UPDATE winston.artifacts SET document = jsonb_set(document, '{metadata,sha256}', to_jsonb(${"b".repeat(64)}::text)) WHERE owner_id = ${f.ownerId}::uuid AND id = ${f.artifact.id}::uuid`;
        if (change === "staging")
          await sql`UPDATE winston.artifact_transfers SET receipt = jsonb_set(receipt, '{path}', '"/data/inbox/other"'::jsonb) WHERE owner_id = ${f.ownerId}::uuid AND id = (SELECT staging_transfer_id FROM winston.device_file_writes WHERE owner_id = ${f.ownerId}::uuid AND action_id = ${f.prepared.action.id}::uuid)`;
        if (change === "source-read")
          await sql`UPDATE winston.device_executions SET state = 'failed' WHERE owner_id = ${f.ownerId}::uuid AND execution_id <> ${f.prepared.action.operationId}::uuid`;
        assert.equal(await f.access(), null, change);
        assert.equal(
          await database.transaction(f.ownerId, ({ actions }) =>
            actions.continueDevice(f.prepared.action.operationId),
          ),
          false,
          change,
        );
      }
    } finally {
      await database.close();
    }
  });
}, 120_000);
