import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, type OwnerTransaction } from "@winston/adapters/database";
import { createTelegramStore } from "@winston/adapters/telegram";
import { withTestPostgres } from "../../src/postgres";

test("responsibilities require current owner agreement and preserve terminal revision history", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const telegram = createTelegramStore(connectionString, 1234);
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const run = <T>(work: (scope: OwnerTransaction) => Promise<T>) =>
      database.transaction(ownerId, work);
    try {
      await run(({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const workspaceId = randomUUID();
      await run(({ workspaces }) => workspaces.register(workspaceId, "Own workspace"));
      const input = {
        key: "check",
        purpose: "Watch for changes to my trip plan.",
        sourceMessageIds: [],
        scope: [
          {
            target: { kind: "workspace" as const, id: workspaceId, resource: null },
            operation: "workspace.file.read" as const,
          },
        ],
      };
      const proposed = await run(({ responsibilities }) => responsibilities.propose(input));
      assert.equal(proposed.state, "proposed");
      assert.equal(proposed.agreement, null);
      assert.equal(
        (await run(({ responsibilities }) => responsibilities.propose(input))).id,
        proposed.id,
      );
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.propose({ ...input, purpose: "Different" })),
        /conflict/,
      );
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.transition(proposed.id, 0, "active")),
        /conflict/,
      );
      assert.equal(
        await database.transaction(stranger, ({ responsibilities }) =>
          responsibilities.find(proposed.id),
        ),
        undefined,
      );
      await assert.rejects(
        database.transaction(stranger, ({ responsibilities }) =>
          responsibilities.agree(proposed.id, 0),
        ),
        /not_found/,
      );
      await assert.rejects(
        database.transaction(stranger, ({ responsibilities }) => responsibilities.propose(input)),
        /invalid_scope/,
      );
      await assert.rejects(
        run(({ responsibilities }) =>
          responsibilities.propose({
            ...input,
            key: "bad-source",
            sourceMessageIds: [randomUUID()],
          }),
        ),
        /invalid_scope/,
      );
      const agreed = await run(({ responsibilities }) => responsibilities.agree(proposed.id, 0));
      assert.equal(agreed.state, "active");
      assert.equal(agreed.agreement?.proposalRevision, 0);
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.agree(proposed.id, 0)),
        /conflict/,
      );
      const paused = await run(({ responsibilities }) =>
        responsibilities.transition(proposed.id, 1, "paused"),
      );
      assert.equal(paused.state, "paused");
      const resumed = await run(({ responsibilities }) =>
        responsibilities.transition(proposed.id, 2, "active"),
      );
      assert.deepEqual(resumed.agreement, agreed.agreement);
      const revised = await run(({ responsibilities }) =>
        responsibilities.revise(proposed.id, 3, {
          purpose: "Watch my next trip only.",
          sourceMessageIds: [],
          scope: [],
        }),
      );
      assert.equal(revised.state, "proposed");
      assert.equal(revised.agreement, null);
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.transition(proposed.id, 4, "active")),
        /conflict/,
      );
      await run(({ responsibilities }) => responsibilities.agree(proposed.id, 4));
      const ended = await run(({ responsibilities }) =>
        responsibilities.transition(proposed.id, 5, "ended"),
      );
      assert.equal(ended.state, "ended");
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.agree(proposed.id, 6)),
        /conflict/,
      );
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.revise(proposed.id, 6, input)),
        /conflict/,
      );
      assert.equal(
        (await run(({ responsibilities }) => responsibilities.propose(input))).state,
        "ended",
      );
      const history = await sql<
        { revision: number }[]
      >`SELECT revision FROM winston.responsibility_history WHERE owner_id = ${ownerId}::uuid AND responsibility_id = ${proposed.id}::uuid ORDER BY revision`;
      assert.deepEqual(
        history.map((row) => row.revision),
        [0, 1, 2, 3, 4, 5, 6],
      );
      assert.equal((await run(({ responsibilities }) => responsibilities.list())).length, 1);
      assert.equal(
        (await database.transaction(stranger, ({ responsibilities }) => responsibilities.list()))
          .length,
        0,
      );

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
      await receive(2, "We could monitor this trip.");
      const events = await sql<
        { id: string }[]
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid`;
      for (const event of events)
        await run(({ conversations }) => conversations.consumeTelegram(event.id));
      const snapshot = await run(({ conversations }) => conversations.snapshot(10));
      const messageId = snapshot.messages[0]?.envelope.messageId;
      assert.ok(messageId);
      const sourced = await run(({ responsibilities }) =>
        responsibilities.propose({ ...input, key: "sourced", sourceMessageIds: [messageId] }),
      );
      assert.deepEqual(sourced.sources, [{ messageId, revision: 0 }]);
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${messageId}::uuid`;
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.agree(sourced.id, 0)),
        /conflict/,
      );
      const counts = await sql<
        { count: number }[]
      >`SELECT count(*)::integer AS count FROM winston.schedules WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(counts[0]?.count, 0);
      await run(({ responsibilities }) =>
        responsibilities.revise(sourced.id, 0, {
          purpose: input.purpose,
          scope: input.scope,
          sourceMessageIds: [messageId],
        }),
      );
      await run(({ responsibilities }) => responsibilities.agree(sourced.id, 1));
      const schedule = await run(({ schedules }) =>
        schedules.create({
          key: "source-revision",
          objective: "Check the agreed trip",
          sourceMessageIds: [messageId],
          timing: { kind: "once", startAt: "2026-01-01T00:00:00.000Z", timezone: "UTC" },
          responsibility: { id: sourced.id, agreementRevision: 1 },
        }),
      );
      const occurrence = await run(({ schedules }) => schedules.claimDue());
      assert.ok(occurrence);
      const worker = await run(({ tasks }) => tasks.claim(occurrence.task.id, 0));
      const pending = await run(({ schedules }) =>
        schedules.create({
          key: "source-revision-pending",
          objective: schedule.objective,
          sourceMessageIds: [messageId],
          timing: schedule.timing,
          responsibility: schedule.responsibility,
        }),
      );
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{revision}', '2') WHERE owner_id = ${ownerId}::uuid AND id = ${messageId}::uuid`;
      const outcome = await run(({ tasks }) =>
        tasks.finishStep(worker.id, worker.revision, worker.generation, {
          state: "succeeded",
          result: "Outdated result",
        }),
      );
      assert.equal(outcome.state, "canceled");
      assert.equal(outcome.result, null);
      assert.equal(await run(({ schedules }) => schedules.claimDue()), undefined);
      assert.equal((await run(({ schedules }) => schedules.find(pending.id)))?.state, "canceled");
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
