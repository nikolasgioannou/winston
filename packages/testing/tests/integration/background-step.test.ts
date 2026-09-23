import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createBackgroundStep } from "@winston/server/background";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createWorkspaceSessions } from "@winston/adapters/workspace";
import type { ModelResult } from "@winston/adapters/models";
import { withTestPostgres } from "../../src/postgres";

const response = (toolCalls: { id: string; name: string; input: unknown }[]): ModelResult => ({
  ok: true,
  text: "",
  toolCalls,
  attempt: {
    role: "worker",
    model: "fixture",
    promptVersion: "fixture",
    elapsedMs: 1,
    firstTextMs: null,
  },
});

test("background steps persist before effects, release approvals and reject duplicate job delivery", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const signal = new AbortController().signal;
    let starts = 0;
    let generations = 0;
    try {
      const queued = await database.transaction(
        ownerId,
        async ({ owners, workspaces, workspaceRuntimes, authorization, tasks }) => {
          await owners.ensure();
          await workspaces.register(workspaceId, "Worker fixture");
          await workspaces.setState(workspaceId, 0, "active");
          await workspaceRuntimes.configure({
            workspaceId,
            revision: 1,
            origin: "http://127.0.0.1:8081",
          });
          await authorization.put({
            revision: 0,
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
            decision: "ask",
          });
          return tasks.create({ key: randomUUID(), objective: "Run pwd", sourceMessageIds: [] });
        },
      );
      const sessions = createWorkspaceSessions({
        database,
        connect: () => ({
          start: async (_credential, command) => {
            starts += 1;
            const saved = await database.transaction(ownerId, ({ actions }) =>
              actions.find(command.dispatch.id),
            );
            assert.equal(saved?.state, "dispatching");
            const output = {
              bytes: 0,
              sha256: createHash("sha256").update("").digest("hex"),
              preview: "",
              truncated: false,
            };
            return {
              request: command.operation,
              state: "completed",
              outcome: {
                state: "completed",
                result: JSON.stringify({
                  exitCode: 0,
                  signal: null,
                  reason: "exited",
                  durationMs: 1,
                  stdout: output,
                  stderr: output,
                }),
              },
            };
          },
          renew: () => Promise.reject(new Error("Unexpected renewal")),
          control: () => Promise.reject(new Error("Unexpected observation")),
        }),
      });
      const step = createBackgroundStep({
        database,
        sessions,
        generate: (request) => {
          generations += 1;
          assert.equal(request.role, "worker");
          assert.match(JSON.stringify(request.messages), /system_event/);
          if (generations === 1)
            return Promise.resolve(
              response([
                {
                  id: "command",
                  name: "workspace_command",
                  input: {
                    workspaceId,
                    command: {
                      argv: ["pwd"],
                      cwd: "/data/home",
                      env: {},
                      timeoutMs: 1000,
                      maxOutputBytes: 4096,
                    },
                  },
                },
              ]),
            );
          assert.match(JSON.stringify(request.messages), /tool-result/);
          assert.match(JSON.stringify(request.messages), /succeeded/);
          return Promise.resolve(
            response([
              {
                id: "finish",
                name: "finish_task",
                input: { state: "succeeded", result: "Verified command complete." },
              },
            ]),
          );
        },
      });
      const read = () => database.transaction(ownerId, ({ tasks }) => tasks.find(queued.id));
      const advance = async () => {
        const task = await read();
        assert.ok(task);
        await step({ ownerId, referenceId: task.id, revision: task.revision }, signal);
      };
      await advance();
      assert.equal((await read())?.state, "queued");
      assert.equal(starts, 0);
      await step({ ownerId, referenceId: queued.id, revision: queued.revision }, signal);
      assert.equal(generations, 1);
      await advance();
      const waiting = await read();
      assert.ok(waiting);
      assert.equal(waiting.state, "waiting");
      const blocker = waiting.blocker;
      assert.ok(blocker);
      assert.equal(blocker.kind, "approval");
      assert.equal(starts, 0);
      await database.transaction(ownerId, async ({ actions, tasks }) => {
        const action = await actions.find(blocker.referenceId);
        assert.ok(action);
        await actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        });
        await tasks.resume(waiting.id, waiting.revision, action.id);
      });
      // A fresh step function emulates a new process: the saved model call is reused.
      const recovered = createBackgroundStep({
        database,
        sessions,
        generate: () => {
          throw new Error("Must recover pending tool before generating");
        },
      });
      const pending = await read();
      assert.ok(pending);
      await recovered({ ownerId, referenceId: pending.id, revision: pending.revision }, signal);
      assert.equal(starts, 1);
      assert.equal(generations, 1);
      await advance();
      assert.equal(generations, 2);
      await advance();
      const completed = await read();
      assert.equal(completed?.state, "succeeded");
      assert.equal(completed.result, "Verified command complete.");
      assert.equal(starts, 1);
    } finally {
      await database.close();
    }
  });
});

test("steering during generation fences the old worker and malformed output fails without tools", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    try {
      const task = await database.transaction(ownerId, async ({ owners, tasks }) => {
        await owners.ensure();
        return tasks.create({ key: randomUUID(), objective: "Original", sourceMessageIds: [] });
      });
      const step = createBackgroundStep({
        database,
        generate: async () => {
          await database.transaction(ownerId, async ({ tasks }) => {
            const current = await tasks.find(task.id);
            assert.ok(current);
            await tasks.steer(current.id, current.revision, "Correction");
          });
          return response([
            { id: "finish", name: "finish_task", input: { state: "succeeded", result: "Stale" } },
          ]);
        },
      });
      await assert.rejects(
        step(
          { ownerId, referenceId: task.id, revision: task.revision },
          new AbortController().signal,
        ),
      );
      const current = await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id));
      assert.ok(current);
      assert.equal(current.state, "queued");
      assert.equal(current.objective, "Correction");
      const invalid = createBackgroundStep({
        database,
        generate: () => Promise.resolve(response([])),
      });
      await invalid(
        { ownerId, referenceId: current.id, revision: current.revision },
        new AbortController().signal,
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id)))?.state,
        "failed",
      );
    } finally {
      await database.close();
    }
  });
});
