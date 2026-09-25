import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { scheduleSchema } from "@winston/contracts/schedules";
import type { CliScheduleRequest } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";

test("schedule CLI fences authority, preserves retry identity and requires current edit revisions", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 1234);
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      let task = await database.transaction(ownerId, async ({ tasks, workspaces, owners }) => {
        await owners.updateTimezone("America/New_York", 0);
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: "fixture",
          objective: "Create reminder",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const issue = async (operation: "gateway:read" | "gateway:control") => {
        const grant = await database.transaction(ownerId, ({ capabilities }) =>
          capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 1,
            taskId: task.id,
            revision: task.revision,
            generation: task.generation,
            operation,
            credential: null,
          }),
        );
        return {
          token: grant.token,
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation,
        };
      };
      let control = await issue("gateway:control");
      const read = await issue("gateway:read");
      const command: CliScheduleRequest = {
        version: 1,
        command: "schedules.create",
        key: "plants",
        objective: "Water the plants",
        startAt: "2030-01-01T14:00:00.000Z",
        rule: "FREQ=DAILY",
      };
      const execute = (request: CliScheduleRequest, credential = control, owner = ownerId) =>
        database.transaction(owner, ({ cli }) => cli.schedule(credential, request));
      assert.equal((await execute(command, read)).status, "denied");
      assert.equal((await execute(command, control, other)).status, "denied");
      const created = await execute(command);
      assert.equal(created.status, "ok");
      const schedule = scheduleSchema.parse(created.data);
      assert.equal(schedule.timing.timezone, "America/New_York");
      await database.transaction(ownerId, ({ owners }) => owners.updateTimezone("Asia/Tokyo", 1));
      task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.yield({
          id: task.id,
          revision: task.revision,
          generation: task.generation,
        });
        return tasks.claim(queued.id, queued.revision);
      });
      assert.equal((await execute(command)).status, "denied");
      control = await issue("gateway:control");
      assert.deepEqual(await execute(command), created);
      const currentRead = await issue("gateway:read");
      const inspected = await execute(
        { version: 1, command: "schedules.inspect", id: schedule.id },
        currentRead,
      );
      assert.deepEqual(inspected, created);
      await assert.rejects(execute({ ...command, objective: "Changed" }), /conflicts/);
      const updated = await execute({
        version: 1,
        command: "schedules.update",
        id: schedule.id,
        revision: 0,
        objective: "New reminder",
        startAt: "2030-01-02T14:00:00.000Z",
      });
      assert.equal(updated.status, "ok");
      assert.equal(scheduleSchema.parse(updated.data).timing.timezone, "America/New_York");
      const pause = {
        version: 1 as const,
        command: "schedules.pause" as const,
        id: schedule.id,
        revision: 1,
      };
      assert.equal((await execute(pause, currentRead)).status, "denied");
      const paused = await execute(pause);
      assert.equal(paused.status, "ok");
      assert.equal(scheduleSchema.parse(paused.data).state, "paused");
      const resumed = await execute({
        version: 1,
        command: "schedules.resume",
        id: schedule.id,
        revision: 2,
      });
      assert.equal(resumed.status, "ok");
      assert.equal(scheduleSchema.parse(resumed.data).state, "active");
      await assert.rejects(
        execute({ version: 1, command: "schedules.cancel", id: schedule.id, revision: 0 }),
        /stale/,
      );

      // A later Telegram request gets its own worker and authority, rather than
      // canceling the completed setup task and leaving the saved schedule active.
      const challenge = await telegram.challenge(ownerId, "fixture");
      const receive = (id: number, text: string) =>
        telegram.receive({
          update_id: id,
          message: {
            message_id: id,
            date: 1_790_000_000 + id,
            from: { id: 123, is_bot: false, first_name: "Owner" },
            chat: { id: 123, type: "private" },
            text,
          },
        });
      await receive(1, `/start ${challenge.secret}`);
      await telegram.confirm(ownerId, "fixture", challenge.id);
      await receive(2, "Cancel my daily plant reminder");
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received'`;
      for (const event of events) {
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      }
      const snapshot = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(10),
      );
      const message = snapshot.messages[0]?.envelope;
      assert.equal(message?.input.text, "Cancel my daily plant reminder");
      assert.ok(message);
      task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "cancel-plants",
          objective: "Cancel the saved daily plant reminder",
          sourceMessageIds: [message.messageId],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      control = await issue("gateway:control");
      const canceled = await execute({
        version: 1,
        command: "schedules.cancel",
        id: schedule.id,
        revision: 3,
      });
      assert.equal(canceled.status, "ok");
      assert.equal(scheduleSchema.parse(canceled.data).state, "canceled");
      await sql`UPDATE winston.schedules SET next_run_at = clock_timestamp() - interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${schedule.id}::uuid`;
      assert.equal(
        await database.transaction(ownerId, ({ schedules }) => schedules.claimDue()),
        undefined,
      );
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
