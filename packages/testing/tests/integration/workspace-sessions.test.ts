import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createWorkspaceSessions } from "@winston/adapters/workspace";
import type { WorkspaceRecord } from "@winston/contracts/workspace";
import { withTestPostgres } from "../../src/postgres";

test("workspace sessions commit before dispatch and recover outcomes without replaying commands", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const unavailableId = randomUUID();
    const approvalId = randomUUID();
    const signal = new AbortController().signal;
    const records = new Map<string, WorkspaceRecord>();
    let starts = 0;
    let renewals = 0;
    const output = {
      bytes: 0,
      sha256: createHash("sha256").update("").digest("hex"),
      preview: "",
      truncated: false,
    };
    const completed = JSON.stringify({
      exitCode: 0,
      signal: null,
      reason: "exited",
      durationMs: 10,
      stdout: output,
      stderr: output,
    });
    try {
      const task = await database.transaction(
        ownerId,
        async ({ owners, tasks, workspaces, workspaceRuntimes, authorization }) => {
          await owners.ensure();
          for (const id of [unavailableId, approvalId]) {
            await workspaces.register(id, "Unavailable fixture");
            await workspaces.setState(id, 0, "active");
          }
          await authorization.put({
            revision: 0,
            target: { kind: "workspace", id: approvalId, resource: null },
            operation: "workspace.command",
            decision: "ask",
          });
          await workspaces.register(workspaceId, "Session fixture");
          await workspaces.setState(workspaceId, 0, "active");
          await workspaceRuntimes.configure({
            workspaceId,
            revision: 1,
            origin: "http://127.0.0.1:8081",
          });
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Session fixture",
            sourceMessageIds: [],
          });
          return tasks.claim(queued.id, queued.revision);
        },
      );
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const step = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.append(worker, {
          key: "model:0",
          afterSequence: 0,
          payload: {
            kind: "model",
            text: "",
            calls: ["normal", "lost-response", "not-started", "outage", "approval", "stale"].map(
              (id) => ({
                id,
                name: "workspace_command",
                input: {
                  workspaceId:
                    id === "outage" ? unavailableId : id === "approval" ? approvalId : workspaceId,
                  command: {
                    argv: [id],
                    cwd: "/data/home",
                    env: {},
                    timeoutMs: 1000,
                    maxOutputBytes: 4096,
                  },
                },
              }),
            ),
          },
        }),
      );
      const sessions = createWorkspaceSessions({
        database,
        connect: (origin) => {
          assert.equal(origin, "http://127.0.0.1:8081");
          return {
            async start(credential, command) {
              starts += 1;
              // The dispatch is visible through a separate transaction before the external call.
              const allowed = await database.transaction(ownerId, ({ workspaces }) =>
                workspaces.authorizeCommand(credential, command),
              );
              assert.ok(allowed);
              if (command.input.argv[0] === "not-started")
                throw new Error("Connection failed before receipt");
              const record: WorkspaceRecord = {
                request: command.operation,
                state: "running",
                outcome: null,
              };
              records.set(command.operation.operationId, record);
              if (command.input.argv[0] === "lost-response")
                throw new Error("Connection failed after receipt");
              return record;
            },
            async renew(credential, command) {
              renewals += 1;
              assert.ok(
                await database.transaction(ownerId, ({ workspaces }) =>
                  workspaces.authorizeCommand(credential, command),
                ),
              );
              const record = records.get(command.operation.operationId);
              if (!record) throw new Error("Unknown operation");
              return record;
            },
            async control(credential, operation) {
              assert.ok(
                await database.transaction(ownerId, ({ workspaces }) =>
                  workspaces.authorizeControl(credential, operation),
                ),
              );
              const record = records.get(operation.operationId);
              if (!record) throw new Error("Unknown operation");
              return record;
            },
          };
        },
      });
      const open = (callId: string, scope = worker) =>
        sessions.open({ ownerId, task: scope, modelStepId: step.id, callId }, signal);
      const outage = await open("outage");
      assert.equal(outage.kind, "blocked");
      assert.equal(outage.reason, "unavailable");
      const approval = await open("approval");
      assert.equal(approval.kind, "blocked");
      assert.equal(approval.reason, "approval");
      assert.equal(starts, 0);
      const normal = await open("normal");
      assert.equal(normal.kind, "session");
      assert.equal((await normal.poll(signal)).kind, "running");
      assert.equal((await normal.poll(signal)).kind, "running");
      assert.equal(renewals, 1);
      const action = await database.transaction(ownerId, ({ actions }) =>
        actions.find(normal.actionId),
      );
      assert.ok(action);
      const record = records.get(action.operationId);
      assert.ok(record);
      const originalRequest = record.request;
      record.request = { ...originalRequest, inputHash: "f".repeat(64) };
      assert.equal((await normal.poll(signal)).kind, "blocked");
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(action.id)))?.state,
        "dispatching",
      );
      record.request = originalRequest;
      record.state = "completed";
      record.outcome = { state: "completed", result: completed };
      assert.equal((await normal.poll(signal)).kind, "finished");
      assert.equal((await open("normal")).kind, "finished");
      assert.equal(starts, 1);

      await open("lost-response");
      await open("not-started");
      assert.equal(starts, 3);
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      const reclaimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      const recovery = {
        id: reclaimed.id,
        revision: reclaimed.revision,
        generation: reclaimed.generation,
      };
      const resumed = await open("lost-response", recovery);
      assert.equal(resumed.kind, "session");
      const recoveredAction = await database.transaction(ownerId, ({ actions }) =>
        actions.find(resumed.actionId),
      );
      assert.ok(recoveredAction);
      const recoveredRecord = records.get(recoveredAction.operationId);
      assert.ok(recoveredRecord);
      recoveredRecord.state = "completed";
      recoveredRecord.outcome = { state: "completed", result: completed };
      assert.equal((await resumed.poll(signal)).kind, "finished");
      const missing = await open("not-started", recovery);
      if (missing.kind !== "session") throw new Error("Expected uncertain session");
      assert.deepEqual(await missing.poll(signal), {
        kind: "blocked",
        actionId: missing.actionId,
        reason: "unknown",
      });
      assert.equal(starts, 3);
      const stale = await open("stale", recovery);
      if (stale.kind !== "session") throw new Error("Expected active session");
      await stale.poll(signal);
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(reclaimed.id, reclaimed.revision),
      );
      const before = renewals;
      assert.equal((await stale.poll(signal)).kind, "blocked");
      assert.equal(renewals, before);
    } finally {
      await database.close();
    }
  });
});
