import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { startBackgroundRuntime } from "@winston/server/background-runtime";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createJobRuntime, workloads } from "@winston/adapters/jobs";
import { workspaceCommandToolInputSchema } from "@winston/contracts/workspace-commands";
import { withTestPostgres } from "../../src/postgres";

test("background runtime advances durable steps independently and stops queue admission on shutdown", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const jobs = createJobRuntime({ directConnectionString: connectionString, onNotice: () => {} });
    const ownerId = randomUUID();
    const unpairedOwner = randomUUID();
    let runtime: Awaited<ReturnType<typeof startBackgroundRuntime>> | undefined;
    let generations = 0;
    let sawScheduledContext = false;
    const create = (owner = ownerId) =>
      database.transaction(owner, ({ tasks }) =>
        tasks.create({ key: randomUUID(), objective: "Queue fixture", sourceMessageIds: [] }),
      );
    async function until(check: () => Promise<boolean>) {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(25);
      }
      assert.fail("Background runtime did not finish its fixture.");
    }
    try {
      for (const owner of [ownerId, unpairedOwner])
        await database.transaction(owner, ({ owners }) => owners.ensure());
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, 123, 1, 1)`;
      const queued = await create();
      const unpaired = await create(unpairedOwner);
      const schedule = await database.transaction(ownerId, ({ schedules }) =>
        schedules.create({
          key: "scheduled-fixture",
          objective: "Scheduled fixture",
          sourceMessageIds: [],
          timing: {
            kind: "once",
            startAt: "2026-01-01T09:00:00.000Z",
            timezone: "America/New_York",
          },
        }),
      );
      const failed = await create();
      const due = await database.transaction(ownerId, async ({ tasks }) => {
        const task = await tasks.create({
          key: randomUUID(),
          objective: "Due retry fixture",
          sourceMessageIds: [],
        });
        const running = await tasks.claim(task.id, task.revision);
        return tasks.finishStep(running.id, running.revision, running.generation, {
          state: "waiting",
          blocker: { kind: "workspace", referenceId: randomUUID(), detail: "Retry fixture" },
        });
      });
      await sql`UPDATE winston.tasks SET retry_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${due.id}::uuid`;
      await jobs.start();
      await sql`UPDATE pgboss.queue SET expire_seconds = 300 WHERE name = 'winston-background'`;
      await jobs.stop();
      await jobs.start();
      const settings = await sql<
        { expiration: number }[]
      >`SELECT expire_seconds AS expiration FROM pgboss.queue WHERE name = 'winston-background'`;
      assert.equal(settings[0]?.expiration, workloads.background.expireInSeconds);
      const jobId = await jobs.enqueue("background", {
        ownerId,
        referenceId: failed.id,
        revision: failed.revision,
      });
      await sql`UPDATE pgboss.job SET state = 'failed', completed_on = clock_timestamp() WHERE id = ${jobId}::uuid AND name = 'winston-background'`;
      runtime = await startBackgroundRuntime({
        database,
        directConnectionString: connectionString,
        jobs,
        botId: 123,
        notice: () => {},
        generate: (request) => {
          generations += 1;
          const context = JSON.stringify(request.messages);
          if (context.includes(schedule.id)) {
            sawScheduledContext = true;
            assert.match(context, /task_context/);
            assert.match(context, /2026-01-01T09:00:00.000Z/);
            assert.match(context, /America\/New_York/);
            assert.match(context, /observedAt/);
          }
          return Promise.resolve({
            ok: true,
            text: "",
            toolCalls: [
              {
                id: "finish",
                name: "finish_task",
                input: { state: "succeeded", result: "Queue fixture complete." },
              },
            ],
            attempt: {
              role: "worker",
              model: "fixture",
              promptVersion: "fixture",
              elapsedMs: 1,
              firstTextMs: null,
            },
          });
        },
      });
      await until(
        async () =>
          (await database.transaction(ownerId, ({ tasks }) => tasks.find(queued.id)))?.state ===
          "succeeded",
      );
      await until(
        async () =>
          (await database.transaction(ownerId, ({ tasks }) => tasks.find(failed.id)))?.state ===
          "failed",
      );
      await until(
        async () =>
          (await database.transaction(ownerId, ({ tasks }) => tasks.find(due.id)))?.state ===
          "succeeded",
      );
      await until(async () => {
        const rows = await sql<{ state: string }[]>`
          SELECT t.document->>'state' AS state FROM winston.schedule_occurrences o
          JOIN winston.tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id
          WHERE o.owner_id = ${ownerId}::uuid AND o.schedule_id = ${schedule.id}::uuid
        `;
        return rows.length === 1 && rows[0]?.state === "succeeded";
      });
      assert.equal(generations, 3);
      assert.equal(sawScheduledContext, true);
      assert.equal(
        (await database.transaction(unpairedOwner, ({ tasks }) => tasks.find(unpaired.id)))?.state,
        "queued",
      );
      await runtime.stop();
      const afterStop = await create();
      await Bun.sleep(750);
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(afterStop.id)))?.state,
        "queued",
      );
      const input = {
        workspaceId: randomUUID(),
        command: {
          argv: ["true"],
          cwd: "/data/home",
          env: {},
          timeoutMs: 86_340_000,
          maxOutputBytes: 4096,
        },
      };
      assert.equal(workspaceCommandToolInputSchema.safeParse(input).success, true);
      assert.equal(
        workspaceCommandToolInputSchema.safeParse({
          ...input,
          command: { ...input.command, argv: [""] },
        }).success,
        false,
      );
      assert.equal(
        workspaceCommandToolInputSchema.safeParse({
          ...input,
          command: { ...input.command, timeoutMs: 86_340_001 },
        }).success,
        false,
      );
    } finally {
      await runtime?.stop();
      await jobs.stop();
      await database.close();
    }
  });
});
