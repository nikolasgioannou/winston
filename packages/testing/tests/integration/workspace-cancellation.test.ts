import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createWorkspaceCancellation, createWorkspaceSessions } from "@winston/adapters/workspace";
import type { WorkspaceRecord } from "@winston/contracts/workspace";
import { withTestPostgres } from "../../src/postgres";

test("cancellation reconciles original commands without claiming unavailable or already completed work stopped", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const workspaceId = randomUUID();
    const records = new Map<string, WorkspaceRecord>();
    const signal = new AbortController().signal;
    let controls = 0;
    let available = false;
    let mismatched = true;
    try {
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      await database.transaction(ownerId, async ({ owners, workspaces, workspaceRuntimes }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Cancellation fixture");
        await workspaces.setState(workspaceId, 0, "active");
        await workspaceRuntimes.configure({
          workspaceId,
          revision: 1,
          origin: "http://127.0.0.1:8081",
        });
      });
      const sessions = createWorkspaceSessions({
        database,
        connect: () => ({
          start: (_credential, command) => {
            const record: WorkspaceRecord = {
              request: command.operation,
              state: "running",
              outcome: null,
            };
            records.set(command.operation.operationId, record);
            return Promise.resolve(record);
          },
          renew: () => Promise.reject(new Error("Unexpected renewal")),
          control: () => Promise.reject(new Error("Unexpected observation")),
        }),
      });
      async function fixture(name: string) {
        const worker = await database.transaction(ownerId, async ({ tasks }) => {
          const task = await tasks.create({
            key: randomUUID(),
            objective: name,
            sourceMessageIds: [],
          });
          const running = await tasks.claim(task.id, task.revision);
          return { id: running.id, revision: running.revision, generation: running.generation };
        });
        const step = await database.transaction(ownerId, ({ taskSteps }) =>
          taskSteps.append(worker, {
            key: "model",
            afterSequence: 0,
            payload: {
              kind: "model",
              text: "",
              calls: [
                {
                  id: "command",
                  name: "workspace_command",
                  input: {
                    workspaceId,
                    command: {
                      argv: ["sleep", "10"],
                      cwd: "/data/home",
                      env: {},
                      timeoutMs: 20000,
                      maxOutputBytes: 4096,
                    },
                  },
                },
              ],
            },
          }),
        );
        const session = await sessions.open(
          { ownerId, task: worker, modelStepId: step.id, callId: "command" },
          signal,
        );
        assert.equal(session.kind, "session");
        const action = await database.transaction(ownerId, ({ actions }) =>
          actions.find(session.actionId),
        );
        assert.ok(action);
        return { worker, action };
      }
      const canceled = await fixture("Cancel");
      const steered = await fixture("Steer");
      const requested = await fixture("Operation cancellation");
      const finished = await fixture("Finished before cancellation");
      const active = await fixture("Unrelated active work");
      await database.transaction(ownerId, async ({ tasks, actions }) => {
        await tasks.cancel(canceled.worker.id, canceled.worker.revision);
        await tasks.steer(steered.worker.id, steered.worker.revision, "Changed intent");
        await actions.requestCancellation(requested.action.id, requested.worker, workspaceId);
        await tasks.cancel(finished.worker.id, finished.worker.revision);
      });
      const output = {
        bytes: 0,
        sha256: createHash("sha256").update("").digest("hex"),
        preview: "",
        truncated: false,
      };
      const reconcile = createWorkspaceCancellation({
        database,
        connect: () => ({
          control: async (credential, operation) => {
            controls += 1;
            assert.equal(credential.operation, "workspace:cancel");
            assert.ok(
              await database.transaction(ownerId, ({ workspaces }) =>
                workspaces.authorizeControl(credential, operation),
              ),
            );
            if (!available) throw new Error("Workspace unavailable");
            assert.notEqual(operation.operationId, active.action.operationId);
            const original = records.get(operation.operationId);
            assert.ok(original);
            const succeeded = operation.operationId === finished.action.operationId;
            return {
              ...original,
              request: mismatched
                ? { ...original.request, operationId: randomUUID() }
                : original.request,
              state: "completed",
              outcome: {
                state: "completed",
                result: JSON.stringify({
                  exitCode: succeeded ? 0 : null,
                  signal: succeeded ? null : "SIGTERM",
                  reason: succeeded ? "exited" : "canceled",
                  durationMs: 1,
                  stdout: output,
                  stderr: output,
                }),
              },
            };
          },
        }),
      });
      await reconcile(otherOwner, undefined, signal);
      assert.equal(controls, 0);
      await reconcile(ownerId, undefined, signal);
      assert.equal(controls, 4);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.taskEffects(canceled.worker.id),
          )
        ).unresolved,
        1,
      );
      available = true;
      await reconcile(ownerId, undefined, signal);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.taskEffects(canceled.worker.id),
          )
        ).unresolved,
        1,
        "Unrelated receipts must not settle the original operation",
      );
      mismatched = false;
      await reconcile(ownerId, undefined, signal);
      for (const entry of [canceled, steered, requested]) {
        const effects = await database.transaction(ownerId, ({ actions }) =>
          actions.taskEffects(entry.worker.id),
        );
        assert.equal(effects.unresolved, 0);
        assert.equal(effects.actions[0]?.state, "failed");
      }
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(finished.action.id)))
          ?.state,
        "succeeded",
      );
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(active.action.id)))
          ?.state,
        "dispatching",
      );
      await reconcile(ownerId, undefined, signal);
      assert.equal(controls, 12, "Settled effects must not be canceled again");
    } finally {
      await database.close();
    }
  });
});
