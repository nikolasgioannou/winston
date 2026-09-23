import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { canonicalJson } from "@winston/contracts/json";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import { withTestPostgres } from "../../src/postgres";

test("durable CLI cancellation races safely with dispatch and revokes running command authorization", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const otherWorkspace = randomUUID();
    const workerId = randomUUID();
    try {
      const task = await database.transaction(ownerId, async ({ owners, workspaces, tasks }) => {
        await owners.ensure();
        for (const id of [workspaceId, otherWorkspace]) {
          await workspaces.register(id, "Cancellation fixture");
          await workspaces.setState(id, 0, "active");
        }
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Cancel fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const version = { id: task.id, revision: task.revision, generation: task.generation };
      const input = {
        argv: ["sleep", "60"],
        cwd: "/data/home",
        env: {},
        timeoutMs: 60000,
        maxOutputBytes: 4096,
      };
      const prepare = (target = workspaceId) =>
        database.transaction(ownerId, ({ actions }) =>
          actions.prepare({
            key: randomUUID(),
            task: version,
            authorization: {
              target: { kind: "workspace", id: target, resource: null },
              operation: "workspace.command",
            },
            arguments: input,
          }),
        );
      const scope = {
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        resourceRevision: 1,
        taskId: task.id,
        revision: task.revision,
        generation: task.generation,
        credential: null,
      };
      const control = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({ ...scope, operation: "gateway:control" }),
      );
      const read = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({ ...scope, operation: "gateway:read" }),
      );
      const credential = {
        token: control.token,
        kind: scope.kind,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:control" as const,
      };
      const cancel = (id: string) =>
        database.transaction(ownerId, ({ cli }) => cli.cancel(credential, id));
      const pending = await prepare();
      assert.equal(
        (
          await database.transaction(ownerId, ({ cli }) =>
            cli.cancel({ ...credential, token: read.token, operation: "gateway:read" }, pending.id),
          )
        ).status,
        "denied",
      );
      assert.equal((await cancel((await prepare(otherWorkspace)).id)).status, "denied");
      assert.equal((await cancel(randomUUID())).status, "denied");
      const canceled = await cancel(pending.id);
      assert.equal(canceled.status, "ok");
      assert.deepEqual(await cancel(pending.id), canceled);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.claim(pending.id, pending.hash, version),
          )
        )?.claimed,
        false,
      );

      const action = await prepare();
      const claim = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, version),
      );
      assert.ok(claim?.claimed);
      const command: WorkspaceCommand = {
        operation: {
          version: 1,
          identity: { ownerId, workspaceId },
          operationId: action.operationId,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          kind: "command:execute",
          inputHash: createHash("sha256").update(canonicalJson(input)).digest("hex"),
        },
        input,
        dispatch: { id: action.id, token: claim.token },
      };
      const execution = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.issueExecution({
          workerId,
          workspaceId,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
        }),
      );
      const executionCredential = {
        token: execution.token,
        kind: "worker" as const,
        subjectId: workerId,
        resourceId: workspaceId,
        operation: "workspace:execute" as const,
      };
      const authorize = () =>
        database.transaction(ownerId, ({ workspaces }) =>
          workspaces.authorizeCommand(executionCredential, command),
        );
      assert.ok(await authorize());
      const legacy = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.issueCli(executionCredential, command, "local"),
      );
      assert.equal(legacy?.controlToken, undefined);
      const negotiated = await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.issueCli(executionCredential, command, "local", true),
      );
      assert.ok(negotiated?.controlToken);
      assert.equal((await cancel(action.id)).status, "waiting");
      assert.equal((await cancel(action.id)).status, "waiting");
      assert.equal(await authorize(), null);
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.cancellationRequested(action.id),
        ),
        true,
      );
      assert.ok(
        await database.transaction(ownerId, ({ workspaces }) =>
          workspaces.issueControl(workerId, command.operation, "workspace:observe"),
        ),
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(action.id, claim.token, {
          state: "failed",
          detail: "Cancellation confirmed by runtime.",
          providerReference: action.operationId,
        }),
      );
      assert.equal((await cancel(action.id)).status, "ok");
    } finally {
      await database.close();
    }
  });
});
