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
      >`SELECT id FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'telegram.message-received'`;
      for (const event of events)
        await run(({ conversations }) => conversations.consumeTelegram(event.id));
      const snapshot = await run(({ conversations }) => conversations.snapshot(10));
      const messageId = snapshot.messages[0]?.envelope.messageId;
      assert.ok(messageId);
      const sourced = await run(({ responsibilities }) =>
        responsibilities.propose({ ...input, key: "sourced", sourceMessageIds: [messageId] }),
      );
      assert.deepEqual(sourced.sources, [{ messageId, revision: 0 }]);
      const provenance = await run(({ responsibilities }) => responsibilities.sources(sourced.id));
      assert.equal(provenance.revision, 0);
      const original = provenance.items[0];
      assert.ok(original);
      assert.equal(original.status, "current");
      assert.equal(original.text, "We could monitor this trip.");
      assert.deepEqual(original.sentAt, snapshot.messages[0]?.envelope.sentAt);
      assert.equal(original.truncated, false);
      assert.equal(original.transcript, null);
      for (const read of ["sources", "history"] as const) {
        await assert.rejects(
          database.transaction(stranger, async ({ responsibilities }) => {
            await responsibilities[read](sourced.id);
          }),
          /not_found/,
        );
        await assert.rejects(
          run(async ({ responsibilities }) => {
            await responsibilities[read](randomUUID());
          }),
          /not_found/,
        );
      }
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{input,text}', to_jsonb(${"x".repeat(4001)}::text)) WHERE owner_id = ${ownerId}::uuid AND id = ${messageId}::uuid`;
      const excerpt = (await run(({ responsibilities }) => responsibilities.sources(sourced.id)))
        .items[0];
      assert.ok(excerpt);
      assert.equal(excerpt.status, "current");
      assert.equal(excerpt.text.length, 4000);
      assert.equal(excerpt.truncated, true);
      await sql`UPDATE winston.conversation_messages SET envelope = jsonb_set(envelope, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${messageId}::uuid`;
      assert.deepEqual(
        (await run(({ responsibilities }) => responsibilities.sources(sourced.id))).items,
        [{ messageId, revision: 0, status: "changed" }],
      );
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

      let historical = await run(({ responsibilities }) =>
        responsibilities.propose({ ...input, key: "history" }),
      );
      for (let revision = 0; revision < 20; revision++) {
        historical = await run(({ responsibilities }) =>
          responsibilities.revise(historical.id, revision, {
            ...input,
            purpose: `Purpose ${String(revision + 1)}`,
          }),
        );
      }
      const firstPage = await run(({ responsibilities }) =>
        responsibilities.history(historical.id),
      );
      assert.deepEqual(
        firstPage.items.map((item) => item.revision),
        [20, 19, 18, 17, 16, 15, 14, 13, 12, 11],
      );
      assert.equal(firstPage.next, 11);
      const secondPage = await run(({ responsibilities }) =>
        responsibilities.history(historical.id, 11),
      );
      assert.deepEqual(
        secondPage.items.map((item) => item.revision),
        [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      );
      assert.equal(secondPage.next, 1);
      const lastPage = await run(({ responsibilities }) =>
        responsibilities.history(historical.id, 1),
      );
      assert.equal(lastPage.items.length, 1);
      assert.equal(lastPage.items[0]?.purpose, input.purpose);
      assert.equal(lastPage.next, null);
      assert.deepEqual(
        await run(({ responsibilities }) => responsibilities.history(historical.id, 0)),
        { items: [], next: null },
      );
      await assert.rejects(
        run(({ responsibilities }) => responsibilities.history(historical.id, -1)),
      );
      const missingId = randomUUID();
      await sql`UPDATE winston.responsibilities SET document = jsonb_set(document, '{sources}', jsonb_build_array(jsonb_build_object('messageId', ${missingId}::text, 'revision', 0))) WHERE owner_id = ${ownerId}::uuid AND id = ${historical.id}::uuid`;
      assert.deepEqual(
        (await run(({ responsibilities }) => responsibilities.sources(historical.id))).items,
        [{ messageId: missingId, revision: 0, status: "unavailable" }],
      );
    } finally {
      await telegram.close();
      await database.close();
    }
  });
});
