import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import type { CliResponsibilityRequest } from "@winston/contracts/cli";
import { responsibilitySchema } from "@winston/contracts/responsibilities";
import { scheduleSchema } from "@winston/contracts/schedules";
import type { Task } from "@winston/contracts/tasks";
import { withTestPostgres } from "../../src/postgres";
import { createConversationLoop } from "@winston/server/conversation";

test("responsibility CLI waits for owner agreement, resumes only its intent and binds setup work", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 123);
    const ownerId = randomUUID();
    const other = randomUUID();
    const workspaceId = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      await database.transaction(ownerId, async ({ workspaces }) => {
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      const challenge = await telegram.challenge(ownerId, "fixture");
      for (const [id, text] of [
        [1, `/start ${challenge.secret}`],
        [2, "Monitor this workspace."],
      ] as const) {
        await telegram.receive({
          update_id: id,
          message: {
            message_id: id,
            date: 1_790_000_000 + id,
            from: { id: 123, is_bot: false, first_name: "Fixture" },
            chat: { id: 123, type: "private" },
            text,
          },
        });
        if (id === 1) await telegram.confirm(ownerId, "fixture", challenge.id);
      }
      const ingress = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received'`;
      for (const event of ingress)
        await database.transaction(ownerId, ({ conversations }) =>
          conversations.consumeTelegram(event.id),
        );
      const snapshot = await database.transaction(ownerId, ({ conversations }) =>
        conversations.snapshot(10),
      );
      const messageId = snapshot.messages.at(-1)?.envelope.messageId;
      assert.ok(messageId);
      const create = () =>
        database.transaction(ownerId, async ({ tasks }) => {
          const task = await tasks.create({
            key: randomUUID(),
            objective: "Propose monitoring",
            sourceMessageIds: [messageId],
          });
          return tasks.claim(task.id, task.revision);
        });
      const issue = async (
        task: Task,
        operation: "gateway:read" | "gateway:control" = "gateway:control",
      ) => {
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
      const input: CliResponsibilityRequest = {
        version: 1,
        command: "responsibilities.propose",
        key: "monitor",
        purpose: "Check workspace changes daily",
        scope: [
          {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
          },
        ],
      };
      const task = await create();
      const control = await issue(task);
      const read = await issue(task, "gateway:read");
      const propose = (credential = control, request = input, owner = ownerId) =>
        database.transaction(owner, ({ cli }) => cli.responsibility(credential, request));
      assert.equal((await propose(read)).status, "denied");
      assert.equal((await propose(control, input, other)).status, "denied");
      const receipt = await propose();
      assert.equal(receipt.status, "waiting");
      const id = receipt.referenceId;
      assert.ok(id);
      const proposal = await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.find(id),
      );
      assert.equal(proposal?.state, "proposed");
      assert.equal(proposal.agreement, null);
      assert.deepEqual(proposal.sources, [{ messageId, revision: 0 }]);
      assert.equal((await propose()).status, "denied");
      assert.equal(
        (await database.transaction(ownerId, ({ schedules }) => schedules.list())).length,
        0,
      );
      assert.equal((await database.transaction(ownerId, ({ tasks }) => tasks.wakeDue())).length, 0);
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'task.changed'`;
      for (const event of events)
        await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.consume(event.id));
      const updates = await database.transaction(ownerId, ({ taskUpdates }) =>
        taskUpdates.pending(),
      );
      assert.equal(updates.length, 1);
      assert.equal(updates[0]?.responsibilityId, id);
      const conversation = await database.transaction(ownerId, ({ conversations }) =>
        conversations.status(),
      );
      let presented = false;
      await createConversationLoop({
        database,
        botId: 123,
        webOrigin: "https://winston.example",
        generate: (request) => {
          assert.ok(
            JSON.stringify(request.messages).includes(
              `https://winston.example/responsibilities/${id}`,
            ),
          );
          presented = true;
          return Promise.resolve({
            ok: true,
            text: "Review the proposed scope.",
            toolCalls: [],
            attempt: {
              role: "conversation",
              model: "fixture",
              promptVersion: "fixture",
              elapsedMs: 1,
              firstTextMs: 1,
            },
          });
        },
      })(ownerId, conversation.revision, new AbortController().signal);
      assert.equal(presented, true);

      // Even a forged blocker on another task cannot acquire the proposal's wake-up.
      const unrelated = await create();
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(unrelated.id, unrelated.revision, unrelated.generation, {
          state: "waiting",
          blocker: { kind: "responsibility", referenceId: id, detail: "Unrelated" },
        }),
      );
      await assert.rejects(
        database.transaction(other, ({ responsibilities }) => responsibilities.agree(id, 0)),
        /not_found/,
      );
      const agreed = await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.agree(id, 0),
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(unrelated.id)))?.state,
        "waiting",
      );
      assert.equal(
        (await database.transaction(ownerId, ({ taskUpdates }) => taskUpdates.pending())).length,
        0,
      );
      const resumed = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.find(task.id);
        assert.equal(queued?.state, "queued");
        return tasks.claim(task.id, queued.revision);
      });
      const current = await issue(resumed);
      const retry = await propose(current);
      assert.equal(retry.status, "ok");
      assert.deepEqual(responsibilitySchema.parse(retry.data), agreed);
      await assert.rejects(propose(current, { ...input, key: "duplicate" }), /already has/);
      assert.equal(
        (await database.transaction(ownerId, ({ responsibilities }) => responsibilities.list()))
          .length,
        1,
      );
      const context = await database.transaction(ownerId, ({ tasks }) =>
        tasks.context({
          id: resumed.id,
          revision: resumed.revision,
          generation: resumed.generation,
        }),
      );
      assert.equal(context.responsibilitySetup?.id, id);
      const scheduleInput = {
        version: 1 as const,
        command: "schedules.create" as const,
        key: "daily",
        objective: "Check workspace changes",
        startAt: "2030-01-01T12:00:00.000Z",
        rule: "FREQ=DAILY",
      };
      assert.equal(
        (await database.transaction(ownerId, ({ cli }) => cli.schedule(current, scheduleInput)))
          .status,
        "denied",
      );
      const scheduled = await database.transaction(ownerId, ({ cli }) =>
        cli.schedule(current, { ...scheduleInput, responsibility: { id, agreementRevision: 0 } }),
      );
      assert.equal(scheduled.status, "ok");
      const schedule = scheduleSchema.parse(scheduled.data);
      assert.equal(schedule.responsibility?.id, id);
      assert.equal(
        await database.transaction(ownerId, ({ responsibilityAccess }) =>
          responsibilityAccess(task.id, {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.file.read",
          }),
        ),
        false,
      );
      await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.transition(id, 1, "paused"),
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id)))?.state,
        "canceled",
      );
      assert.equal(
        (await database.transaction(ownerId, ({ schedules }) => schedules.find(schedule.id)))
          ?.state,
        "paused",
      );
      assert.equal((await propose(current)).status, "denied");

      // Steering changes intent: agreement to the old proposal cannot resume the newer work.
      const steered = await create();
      const second = await propose(await issue(steered));
      assert.equal(second.status, "waiting");
      const secondId = second.referenceId;
      assert.ok(secondId);
      const newer = await database.transaction(ownerId, async ({ tasks }) => {
        const waiting = await tasks.find(steered.id);
        assert.ok(waiting);
        return tasks.steer(waiting.id, waiting.revision, "Do different work");
      });
      await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.agree(secondId, 0),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.find(steered.id)),
        newer,
      );
      await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.transition(secondId, 1, "ended"),
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.find(steered.id)),
        newer,
      );

      const stale = await create();
      const third = await propose(await issue(stale));
      assert.equal(third.status, "waiting");
      const thirdId = third.referenceId;
      assert.ok(thirdId);
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${messageId}::uuid`;
      await assert.rejects(
        database.transaction(ownerId, ({ responsibilities }) => responsibilities.agree(thirdId, 0)),
        /conflict/,
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(stale.id)))?.state,
        "waiting",
      );
      await database.transaction(ownerId, ({ responsibilities }) =>
        responsibilities.transition(thirdId, 0, "ended"),
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.find(stale.id)))?.state,
        "canceled",
      );
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
