import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";
import { createConnectedReadGateway } from "@winston/adapters/google";

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
        arguments: {
          version: 1 as const,
          command: "gmail.search" as const,
          accountId,
          query: "subject:fixture",
          limit: 1,
        },
      };
      const prepare = (worker = request.task, input = request.arguments) =>
        database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.prepare(worker, request.key, input),
        );
      await database.transaction(ownerId, ({ connectionTargets }) =>
        connectionTargets.bind(
          {
            operation: "gmail.read",
            task: { id: task.id, revision: task.revision },
            explicit: { connectionId: accountId, calendarId: null },
          },
          { connectionId: accountId, calendarId: null },
        ),
      );
      const { action } = await prepare();
      assert.equal((await prepare()).action.id, action.id);
      await assert.rejects(
        prepare(request.task, { ...request.arguments, query: "different" }),
        /conflicts/,
      );
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
      assert.equal((await prepare(worker)).action.id, action.id);
      await assert.rejects(prepare(), /stale/);
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
      const workspaceId = randomUUID();
      let cliTask = await database.transaction(ownerId, async ({ workspaces, tasks }) => {
        await workspaces.register(workspaceId, "Approval fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Read through CLI",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const issue = async () => {
        const capability = await database.transaction(ownerId, ({ capabilities }) =>
          capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 1,
            taskId: cliTask.id,
            revision: cliTask.revision,
            generation: cliTask.generation,
            operation: "gateway:control",
            credential: null,
          }),
        );
        return {
          token: capability.token,
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation: "gateway:control" as const,
        };
      };
      let fetches = 0;
      const fetchCount = () => fetches;
      const gateway = createConnectedReadGateway({
        database,
        google: {
          list: (owner) => database.transaction(owner, ({ connections }) => connections.list()),
          calendars: () => Promise.resolve([]),
          access: () =>
            Promise.resolve({
              kind: "ready" as const,
              revision: 0,
              grant: {
                accessToken: "synthetic",
                refreshToken: "synthetic",
                expiresAt: "2030-01-01T00:00:00.000Z",
                scopes: [...googleScopes.gmail],
              },
            }),
          rejected: () => Promise.resolve(),
        },
        fetch: () => {
          fetches += 1;
          return Promise.resolve(Response.json({ messages: [{ id: "m1", threadId: "t1" }] }));
        },
      });
      const keyed = { ...request.arguments, key: "read-fixture" };
      const signal = new AbortController().signal;
      const waiting = await gateway(await issue(), keyed, signal);
      assert.equal(waiting.status, "waiting");
      assert.notEqual(waiting.status, "ok");
      assert.ok(waiting.referenceId);
      const approvalId = waiting.referenceId;
      assert.equal(fetchCount(), 0);
      const waitingTask = await database.transaction(ownerId, ({ tasks }) =>
        tasks.find(cliTask.id),
      );
      assert.equal(waitingTask?.state, "waiting");
      const proposal = await database.transaction(ownerId, ({ actions }) =>
        actions.find(approvalId),
      );
      assert.ok(proposal);
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: proposal.id,
          revision: proposal.revision,
          hash: proposal.hash,
          approve: true,
        }),
      );
      cliTask = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.resume(cliTask.id, waitingTask.revision, proposal.id);
        return tasks.claim(queued.id, queued.revision);
      });
      const resumed = await issue();
      const first = await gateway(resumed, keyed, signal);
      assert.equal(first.status, "ok");
      assert.equal(fetchCount(), 1);
      assert.deepEqual(await gateway(resumed, keyed, signal), first);
      assert.equal(fetchCount(), 1);
      assert.equal(
        (await gateway(resumed, { ...keyed, query: "changed" }, signal)).status,
        "unavailable",
      );
      assert.equal(fetchCount(), 1);
      const rejectedRequest = { ...keyed, key: "rejected-read" };
      const rejectionWait = await gateway(resumed, rejectedRequest, signal);
      assert.equal(rejectionWait.status, "waiting");
      assert.ok(rejectionWait.referenceId);
      const rejectionId = rejectionWait.referenceId;
      await database.transaction(ownerId, async ({ actions }) => {
        const pending = await actions.find(rejectionId);
        assert.ok(pending);
        await actions.decide({
          id: pending.id,
          revision: pending.revision,
          hash: pending.hash,
          approve: false,
        });
      });
      cliTask = await database.transaction(ownerId, async ({ tasks }) => {
        const paused = await tasks.find(cliTask.id);
        assert.ok(paused);
        const queued = await tasks.resume(paused.id, paused.revision, rejectionId);
        return tasks.claim(queued.id, queued.revision);
      });
      const afterRejection = await issue();
      assert.equal((await gateway(afterRejection, rejectedRequest, signal)).status, "denied");
      assert.equal(fetchCount(), 1);
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({ ...request.authorization, decision: "deny", revision: 0 }),
      );
      assert.equal((await gateway(afterRejection, keyed, signal)).status, "unavailable");
      assert.equal(fetchCount(), 1);
      assert.equal(await check(), false);
      const result = {
        version: 1 as const,
        status: "unavailable" as const,
        message: "Policy changed.",
      };
      assert.equal(
        await database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.complete(action.id, "wrong", result),
        ),
        null,
      );
      assert.deepEqual(
        await database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.complete(action.id, claimed.token, result),
        ),
        result,
      );
      assert.deepEqual((await prepare(worker)).result, result);
      assert.deepEqual(
        await database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.complete(action.id, claimed.token, result),
        ),
        result,
      );
      assert.equal(
        await database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.complete(action.id, claimed.token, {
            ...result,
            message: "Changed receipt",
          }),
        ),
        null,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ connectedReads }) =>
          connectedReads.complete(action.id, claimed.token, {
            version: 1,
            status: "ok",
            data: "x".repeat(900_001),
          }),
        ),
        /receipt/,
      );
      assert.equal(await check(), false);
    } finally {
      await database.close();
    }
  });
});
