import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("connected read proofs bind exact arguments, current workers and live policy", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 7).toString("base64") }),
    );
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const connection: Connection = {
        id: accountId,
        service: "gmail",
        subject: accountId,
        email: "approval@example.com",
        scopes: [...googleScopes.gmail],
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await vault.put(
        ownerId,
        accountId,
        {
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: connection.scopes,
        },
        null,
      );
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      let task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Read approval",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const request = {
        key: randomUUID(),
        task: { id: task.id, revision: task.revision, generation: task.generation },
        authorization: {
          target: { kind: "connection" as const, id: accountId, resource: null },
          operation: "gmail.read" as const,
        },
        arguments: { command: "gmail.search", query: "subject:fixture", limit: 1 },
      };
      const action = await database.transaction(ownerId, ({ actions }) => actions.prepare(request));
      assert.equal(action.state, "pending");
      task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(task.id, task.revision, task.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId: action.id, detail: "Approve read" },
        }),
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        }),
      );
      task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.resume(task.id, task.revision, action.id);
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const claimed = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, worker),
      );
      assert.ok(claimed?.claimed);
      const proof = {
        id: action.id,
        token: claimed.token,
        task: worker,
        authorization: request.authorization,
        arguments: request.arguments,
      };
      const check = (value = proof) =>
        database.transaction(ownerId, ({ actions }) => actions.authorizeConnectionRead(value));
      assert.equal(await check(), true);
      assert.equal(await check({ ...proof, token: "wrong" }), false);
      assert.equal(await check({ ...proof, task: request.task }), false);
      assert.equal(
        await check({ ...proof, arguments: { ...request.arguments, query: "changed" } }),
        false,
      );
      assert.equal(
        await check({
          ...proof,
          authorization: {
            ...request.authorization,
            target: { ...request.authorization.target, id: randomUUID() },
          },
        }),
        false,
      );
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(stranger, ({ actions }) =>
          actions.authorizeConnectionRead(proof),
        ),
        false,
      );
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({ ...request.authorization, decision: "deny", revision: 0 }),
      );
      assert.equal(await check(), false);
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(action.id, claimed.token, {
          state: "failed",
          detail: "Policy changed before provider read",
          providerReference: null,
        }),
      );
      assert.equal(await check(), false);
    } finally {
      await database.close();
    }
  });
});
