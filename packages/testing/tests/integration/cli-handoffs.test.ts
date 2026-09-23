import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";
import { googleScopes } from "@winston/contracts/connections";

test("CLI setup parks only its authorized live task without granting provider access", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    try {
      const worker = await database.transaction(ownerId, async ({ owners, workspaces, tasks }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const task = await tasks.create({
          key: randomUUID(),
          objective: "Find itinerary",
          sourceMessageIds: [],
        });
        return tasks.claim(task.id, task.revision);
      });
      const scope = {
        kind: "workspace",
        subjectId: workspaceId,
        resourceId: workspaceId,
        resourceRevision: 1,
        taskId: worker.id,
        revision: worker.revision,
        generation: worker.generation,
        operation: "gateway:control",
        credential: null,
      } as const;
      const grant = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue(scope),
      );
      const credential = {
        token: grant.token,
        kind: scope.kind,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: scope.operation,
      };
      const request = {
        version: 1,
        command: "accounts.connect",
        service: "gmail",
        key: "itinerary",
        detail: "Connect Gmail to find the itinerary.",
      } as const;
      assert.equal(
        (
          await database.transaction(ownerId, ({ cli }) =>
            cli.connect({ ...credential, operation: "gateway:read" }, request),
          )
        ).status,
        "denied",
      );
      assert.equal(
        (await database.transaction(randomUUID(), ({ cli }) => cli.connect(credential, request)))
          .status,
        "denied",
      );
      const result = await database.transaction(ownerId, ({ cli }) =>
        cli.connect(credential, request),
      );
      assert.equal(result.status, "waiting");
      const referenceId = result.referenceId;
      assert.ok(referenceId);
      const handoff = await database.transaction(ownerId, ({ handoffs }) =>
        handoffs.find(referenceId),
      );
      assert.equal(handoff?.taskId, worker.id);
      assert.equal(handoff.state, "pending");
      assert.deepEqual(
        await database.transaction(ownerId, ({ connections }) => connections.list()),
        [],
      );
      assert.equal(
        (await database.transaction(ownerId, ({ cli }) => cli.connect(credential, request))).status,
        "denied",
        "Parking invalidates the old worker credential",
      );
      const task = await database.transaction(ownerId, ({ tasks }) => tasks.find(worker.id));
      assert.equal(task?.state, "waiting");
      assert.equal(task.blocker?.referenceId, handoff.id);
      const connectionId = randomUUID();
      const connection = {
        id: connectionId,
        service: "gmail",
        subject: "fixture",
        email: "fixture@example.com",
        scopes: [...googleScopes.gmail],
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await sql`INSERT INTO winston.credentials (owner_id, id, provider, revision, encrypted) VALUES (${ownerId}::uuid, ${connectionId}::uuid, 'google', 0, '{}'::jsonb)`;
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document) VALUES (${ownerId}::uuid, ${connectionId}::uuid, 'fixture', 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      await database.transaction(ownerId, ({ handoffs }) =>
        handoffs.completeVerified(referenceId, { kind: "connection", connectionId }),
      );
      const resumed = await database.transaction(ownerId, async ({ tasks, capabilities }) => {
        const current = await tasks.find(worker.id);
        assert.ok(current);
        const next = await tasks.claim(current.id, current.revision);
        return capabilities.issue({
          ...scope,
          revision: next.revision,
          generation: next.generation,
        });
      });
      const recovered = await database.transaction(ownerId, ({ cli }) =>
        cli.connect({ ...credential, token: resumed.token }, request),
      );
      assert.deepEqual(recovered, {
        version: 1,
        status: "ok",
        data: { handoffId: referenceId, connectionId },
      });
      const completed = await database.transaction(ownerId, ({ handoffs }) =>
        handoffs.completedForTask(worker.id),
      );
      assert.equal(completed[0]?.resolutionId, connectionId);
      assert.deepEqual(
        await database.transaction(randomUUID(), ({ handoffs }) =>
          handoffs.completedForTask(worker.id),
        ),
        [],
      );
    } finally {
      await database.close();
    }
  });
});
