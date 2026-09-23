import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { ActionRecord } from "@winston/contracts/actions";
import { withTestPostgres } from "../../src/postgres";

async function fixture(connectionString: string) {
  await migrateDatabase(connectionString);
  const database = createDatabase({ connectionString, onConnectionError: () => {} });
  const ownerId = randomUUID();
  await database.transaction(ownerId, ({ owners }) => owners.ensure());
  const device = await database.transaction(ownerId, async ({ devices }) => {
    const challenge = await devices.start("Action fixture");
    const result = await devices.pair(challenge.secret, {
      platform: "macos",
      appVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["command"],
    });
    assert.ok(result);
    return result.device;
  });
  const authorization = {
    target: { kind: "device" as const, id: device.id, resource: null },
    operation: "device.command" as const,
  };
  async function start() {
    return database.transaction(ownerId, async ({ tasks }) => {
      const queued = await tasks.create({
        key: randomUUID(),
        objective: "Synthetic action test",
        sourceMessageIds: [],
      });
      return tasks.claim(queued.id, queued.revision);
    });
  }
  const approve = (action: ActionRecord) =>
    database.transaction(ownerId, ({ actions }) =>
      actions.decide({
        id: action.id,
        revision: action.revision,
        hash: action.hash,
        approve: true,
      }),
    );
  return { database, ownerId, device, authorization, start, approve };
}

test("exact approvals survive waiting and worker renewal but dispatch only once", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    const f = await fixture(connectionString);
    try {
      let task = await f.start();
      const request = {
        key: randomUUID(),
        task: { id: task.id, revision: task.revision, generation: task.generation },
        authorization: f.authorization,
        arguments: { command: "echo", arguments: ["fixture"] },
      };
      const prepare = (input = request) =>
        f.database.transaction(f.ownerId, ({ actions }) => actions.prepare(input));
      const action = await prepare();
      assert.equal(action.state, "pending");
      assert.equal(
        (await prepare({ ...request, arguments: { arguments: ["fixture"], command: "echo" } })).id,
        action.id,
      );
      await assert.rejects(
        prepare({ ...request, arguments: { ...request.arguments, command: "changed" } }),
        /conflicts/,
      );
      const stranger = randomUUID();
      await f.database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await f.database.transaction(stranger, ({ actions }) => actions.find(action.id)),
        null,
      );
      assert.equal(
        await f.database.transaction(f.ownerId, ({ actions }) =>
          actions.decide({ id: action.id, revision: 0, hash: "a".repeat(64), approve: true }),
        ),
        null,
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, request.task),
          )
        )?.claimed,
        false,
      );

      task = await f.database.transaction(f.ownerId, ({ tasks }) =>
        tasks.finishStep(task.id, task.revision, task.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId: action.id, detail: "Review action" },
        }),
      );
      const approved = await f.approve(action);
      assert.equal(approved?.state, "approved");
      task = await f.database.transaction(f.ownerId, async ({ tasks }) => {
        const queued = await tasks.resume(task.id, task.revision, action.id);
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const claims = await Promise.all(
        [0, 1].map(() =>
          f.database.transaction(f.ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          ),
        ),
      );
      const claimed = claims.find((result) => result?.claimed);
      assert.ok(claimed?.claimed);
      assert.equal(claims.filter((result) => result?.claimed).length, 1);
      assert.equal(claimed.action.operationId, action.operationId);
      const outcome = {
        state: "unknown" as const,
        detail: "Transport ended after dispatch",
        providerReference: null,
      };
      assert.equal(
        await f.database.transaction(f.ownerId, ({ actions }) =>
          actions.report(action.id, "wrong", outcome),
        ),
        null,
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.report(action.id, claimed.token, outcome),
          )
        )?.state,
        "unknown",
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          )
        )?.claimed,
        false,
      );
      const verified = {
        state: "succeeded" as const,
        detail: "Executor journal confirms completion",
        providerReference: "synthetic-operation",
      };
      assert.equal(
        await f.database.transaction(f.ownerId, ({ actions }) =>
          actions.reconcile(action.id, randomUUID(), verified),
        ),
        null,
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.reconcile(action.id, action.operationId, verified),
          )
        )?.state,
        "succeeded",
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.report(action.id, claimed.token, verified),
          )
        )?.state,
        "succeeded",
      );
      assert.equal(
        await f.database.transaction(f.ownerId, ({ actions }) =>
          actions.report(action.id, claimed.token, { ...verified, state: "failed" }),
        ),
        null,
      );
    } finally {
      await f.database.close();
    }
  });
});

test("steering, expiry, policy changes and resource revocation invalidate prior action approval", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const f = await fixture(connectionString);
    try {
      let task = await f.start();
      const prepare = () =>
        f.database.transaction(f.ownerId, ({ actions }) =>
          actions.prepare({
            key: randomUUID(),
            task: { id: task.id, revision: task.revision, generation: task.generation },
            authorization: f.authorization,
            arguments: { command: "fixture" },
          }),
        );
      const pending = await prepare();
      task = await f.database.transaction(f.ownerId, async ({ tasks }) => {
        // Even steering back to identical wording is a new instruction generation.
        const queued = await tasks.steer(task.id, task.revision, task.objective);
        return tasks.claim(queued.id, queued.revision);
      });
      assert.equal((await f.approve(pending))?.state, "invalidated");
      await f.database.transaction(f.ownerId, ({ authorization }) =>
        authorization.put({ ...f.authorization, decision: "allow", revision: 0 }),
      );
      const claim = (action: ActionRecord) =>
        f.database.transaction(f.ownerId, ({ actions }) =>
          actions.claim(action.id, action.hash, {
            id: task.id,
            revision: task.revision,
            generation: task.generation,
          }),
        );
      const stalePolicy = await prepare();
      await f.database.transaction(f.ownerId, ({ authorization }) =>
        authorization.put({ ...f.authorization, decision: "allow", revision: 1 }),
      );
      assert.equal((await claim(stalePolicy))?.action.state, "invalidated");
      const expired = await prepare();
      await sql`UPDATE winston.actions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal((await claim(expired))?.action.state, "invalidated");
      const revoked = await prepare();
      await f.database.transaction(f.ownerId, ({ devices }) =>
        devices.revoke(f.device.id, f.device.revision),
      );
      assert.equal((await claim(revoked))?.action.state, "invalidated");
    } finally {
      await f.database.close();
    }
  });
});

test("cancel versus dispatch has one durable winner and late effects remain reportable", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    const f = await fixture(connectionString);
    try {
      await f.database.transaction(f.ownerId, ({ authorization }) =>
        authorization.put({ ...f.authorization, decision: "allow", revision: 0 }),
      );
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const task = await f.start();
        const worker = { id: task.id, revision: task.revision, generation: task.generation };
        const action = await f.database.transaction(f.ownerId, ({ actions }) =>
          actions.prepare({
            key: randomUUID(),
            task: worker,
            authorization: f.authorization,
            arguments: { attempt },
          }),
        );
        if (attempt === 0) {
          await f.database.transaction(f.ownerId, ({ tasks }) =>
            tasks.cancel(task.id, task.revision),
          );
          assert.equal(
            await f.database.transaction(f.ownerId, ({ actions }) =>
              actions.claim(action.id, action.hash, worker),
            ),
            null,
          );
          continue;
        }
        const [claim] = await Promise.all([
          f.database.transaction(f.ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          ),
          f.database.transaction(f.ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision)),
        ]);
        if (claim?.claimed) {
          assert.equal(
            (
              await f.database.transaction(f.ownerId, ({ actions }) =>
                actions.report(action.id, claim.token, {
                  state: "succeeded",
                  detail: "Already dispatched effect completed",
                  providerReference: "synthetic",
                }),
              )
            )?.state,
            "succeeded",
          );
        } else assert.equal(claim, null);
        assert.equal(
          (await f.database.transaction(f.ownerId, ({ tasks }) => tasks.find(task.id)))?.state,
          "canceled",
        );
      }
    } finally {
      await f.database.close();
    }
  });
});

test("lost worker leases recover to unknown without allowing a new worker to replay", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    const f = await fixture(connectionString);
    try {
      await f.database.transaction(f.ownerId, ({ authorization }) =>
        authorization.put({ ...f.authorization, decision: "allow", revision: 0 }),
      );
      let task = await f.start();
      const action = await f.database.transaction(f.ownerId, ({ actions }) =>
        actions.prepare({
          key: randomUUID(),
          task: { id: task.id, revision: task.revision, generation: task.generation },
          authorization: f.authorization,
          arguments: {},
        }),
      );
      const claim = await f.database.transaction(f.ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, {
          id: task.id,
          revision: task.revision,
          generation: task.generation,
        }),
      );
      assert.ok(claim?.claimed);
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE id = ${task.id}::uuid`;
      task = await f.database.transaction(f.ownerId, ({ tasks }) =>
        tasks.claim(task.id, task.revision),
      );
      assert.equal(
        (await f.database.transaction(f.ownerId, ({ actions }) => actions.recover(action.id)))
          ?.state,
        "unknown",
      );
      assert.equal(
        (
          await f.database.transaction(f.ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, {
              id: task.id,
              revision: task.revision,
              generation: task.generation,
            }),
          )
        )?.claimed,
        false,
      );
    } finally {
      await f.database.close();
    }
  });
});
