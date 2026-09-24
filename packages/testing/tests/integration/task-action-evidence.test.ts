import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase, TaskWriteError } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("action evidence is paged and private while cancellation retains uncertain effects", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const device = await database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Synthetic evidence fixture");
        const paired = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(paired);
        return paired.device;
      });
      const worker = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "evidence",
          objective: "Synthetic evidence",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const records = [];
      const authority = { id: worker.id, revision: worker.revision, generation: worker.generation };
      for (let index = 0; index < 43; index++) {
        records.push(
          await database.transaction(ownerId, ({ actions }) =>
            actions.prepare({
              key: `action:${String(index)}`,
              task: { id: worker.id, revision: worker.revision, generation: worker.generation },
              authorization: {
                target: { kind: "device", id: device.id, resource: null },
                operation: "device.command",
              },
              arguments: { command: "PRIVATE_ARGUMENT_SENTINEL" },
            }),
          ),
        );
      }
      const firstRecord = records[0];
      const secondRecord = records[1];
      assert.ok(firstRecord && secondRecord);
      for (const record of [firstRecord, secondRecord]) {
        await database.transaction(ownerId, ({ actions }) =>
          actions.decide({
            id: record.id,
            revision: record.revision,
            hash: record.hash,
            approve: true,
          }),
        );
      }
      const dispatched = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(firstRecord.id, firstRecord.hash, authority),
      );
      assert.ok(dispatched?.claimed);
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(firstRecord.id, dispatched.token, {
          state: "unknown",
          detail: "PRIVATE_OUTPUT_SENTINEL",
          providerReference: "PRIVATE_REFERENCE_SENTINEL",
        }),
      );
      const inFlight = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(secondRecord.id, secondRecord.hash, authority),
      );
      assert.ok(inFlight?.claimed);
      await assert.rejects(
        database.transaction(other, ({ tasks }) => tasks.cancel(worker.id, worker.revision)),
        (error) => error instanceof TaskWriteError && error.kind === "not_found",
      );
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.cancel(worker.id, worker.revision + 1)),
        (error) => error instanceof TaskWriteError && error.kind === "conflict",
      );
      const canceled = await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(worker.id, worker.revision),
      );
      assert.equal(canceled.state, "canceled");
      assert.equal(canceled.generation, worker.generation + 1);
      await assert.rejects(
        database.transaction(ownerId, ({ tasks }) => tasks.cancel(worker.id, worker.revision)),
        (error) => error instanceof TaskWriteError && error.kind === "conflict",
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.cancel(worker.id, canceled.revision),
          )
        ).revision,
        canceled.revision,
      );
      const seen: string[] = [];
      let after: string | undefined;
      do {
        const page = await database.transaction(ownerId, ({ tasks }) =>
          tasks.actionEvidence(worker.id, after),
        );
        assert.equal(page.unresolved, 2);
        assert.ok(page.items.length <= 20);
        for (const item of page.items) {
          assert.deepEqual(Object.keys(item).sort(), [
            "authorization",
            "decisionSource",
            "expiresAt",
            "id",
            "intentRevision",
            "state",
          ]);
          if (item.id === firstRecord.id) assert.equal(item.state, "unknown");
          if (item.id === secondRecord.id) assert.equal(item.state, "dispatching");
        }
        assert.equal(JSON.stringify(page).includes("PRIVATE_"), false);
        assert.equal(JSON.stringify(page).includes(dispatched.token), false);
        seen.push(...page.items.map((item) => item.id));
        after = page.next ?? undefined;
      } while (after);
      assert.deepEqual(seen, records.map((record) => record.id).sort());
      assert.deepEqual(
        await database.transaction(other, ({ tasks }) => tasks.actionEvidence(worker.id)),
        { unresolved: 0, items: [], next: null },
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ tasks }) => tasks.actionEvidence(randomUUID())),
        { unresolved: 0, items: [], next: null },
      );
      const pending = records[2];
      assert.ok(pending);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.decide({
              id: pending.id,
              revision: pending.revision,
              hash: pending.hash,
              approve: true,
            }),
          )
        )?.state,
        "invalidated",
      );
      assert.equal(
        (await database.transaction(ownerId, ({ tasks }) => tasks.actionEvidence(worker.id)))
          .unresolved,
        2,
      );
    } finally {
      await database.close();
    }
  });
});
