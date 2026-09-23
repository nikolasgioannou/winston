import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { taskStepRequestSchema, type TaskStepRequest } from "@winston/contracts/task-steps";
import { withTestPostgres } from "../../src/postgres";

test("checkpoints survive worker recovery but fence stale leases, other owners and changed intent", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    try {
      const task = await database.transaction(ownerId, async ({ owners, tasks, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Checkpoint fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Checkpoint fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const action = await database.transaction(ownerId, ({ actions }) =>
        actions.prepare({
          key: randomUUID(),
          task: worker,
          authorization: {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
          },
          arguments: { argv: ["pwd"] },
        }),
      );
      const request: TaskStepRequest = {
        key: "model:0",
        afterSequence: 0,
        payload: {
          kind: "model",
          text: "",
          calls: [{ id: "call-1", name: "workspace_command", input: { argv: ["pwd"] } }],
        },
      };
      const append = (input: TaskStepRequest, scope = worker) =>
        database.transaction(ownerId, ({ taskSteps }) => taskSteps.append(scope, input));
      const first = await append(request);
      assert.deepEqual(await append(request), first);
      await assert.rejects(
        append({ ...request, payload: { kind: "model", text: "Changed", calls: [] } }),
        /conflicts/,
      );
      await assert.rejects(append({ ...request, key: "another" }), /sequence/);
      await assert.rejects(
        database.transaction(randomUUID(), ({ taskSteps }) => taskSteps.list(worker)),
        /unavailable/,
      );
      const tool: TaskStepRequest = {
        key: "tool:1",
        afterSequence: 1,
        payload: {
          kind: "tool",
          modelStepId: first.id,
          callId: "call-1",
          actionId: action.id,
          result: { output: "/data/home" },
        },
      };
      assert.equal(tool.payload.kind, "tool");
      await assert.rejects(
        append({ ...tool, payload: { ...tool.payload, callId: "missing" } }),
        /matching/,
      );
      await assert.rejects(
        append({ ...tool, payload: { ...tool.payload, actionId: randomUUID() } }),
        /unrelated/,
      );
      const result = await append(tool);
      assert.deepEqual(await append(tool), result);
      await assert.rejects(append({ ...tool, key: "duplicate-call", afterSequence: 2 }));

      // Simulate a crashed worker's expired lease without waiting a minute.
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid`;
      await assert.rejects(
        append({
          key: "expired",
          afterSequence: 2,
          payload: { kind: "model", text: "Done", calls: [] },
        }),
        /lease/,
      );
      const recovered = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      const recovery = {
        id: recovered.id,
        revision: recovered.revision,
        generation: recovered.generation,
      };
      await assert.rejects(
        database.transaction(ownerId, ({ taskSteps }) => taskSteps.list(worker)),
        /lease/,
      );
      const page = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.list(recovery, 0, 1),
      );
      assert.deepEqual(page.steps, [first]);
      assert.equal(page.hasMore, true);
      const next = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.list(recovery, 1, 1),
      );
      assert.deepEqual(next.steps, [result]);
      assert.equal(next.hasMore, false);
      assert.deepEqual(await append(tool, recovery), result);
      const racing = await Promise.allSettled(
        ["race-a", "race-b"].map((key) =>
          append(
            {
              key,
              afterSequence: 2,
              payload: { kind: "model", text: "Complete", calls: [] },
            },
            recovery,
          ),
        ),
      );
      assert.equal(racing.filter((entry) => entry.status === "fulfilled").length, 1);
      assert.equal(racing.filter((entry) => entry.status === "rejected").length, 1);

      const changed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(recovered.id, recovered.revision, "Different intent"),
      );
      const claimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(changed.id, changed.revision),
      );
      const newWorker = {
        id: claimed.id,
        revision: claimed.revision,
        generation: claimed.generation,
      };
      const fresh = await database.transaction(ownerId, ({ taskSteps }) =>
        taskSteps.list(newWorker),
      );
      assert.equal(fresh.intentRevision, 1);
      assert.deepEqual(fresh.steps, []);
      const newFirst = await append(request, newWorker);
      assert.notEqual(newFirst.id, first.id);
      await assert.rejects(append(tool, newWorker), /matching/);
      assert.equal(
        (
          await sql<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM winston.task_steps WHERE owner_id = ${ownerId}::uuid`
        )[0]?.count,
        4,
      );
      assert.equal(
        taskStepRequestSchema.safeParse({
          ...request,
          payload: { kind: "model", text: "x".repeat(100_001), calls: [] },
        }).success,
        false,
      );
      assert.equal(
        taskStepRequestSchema.safeParse({
          ...request,
          payload: {
            kind: "model",
            text: "",
            calls: [{ id: "large", name: "tool", input: "😀".repeat(40_000) }],
          },
        }).success,
        false,
      );
    } finally {
      await database.close();
    }
  });
});
