import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createConnectedReadGateway } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("connected CLI reads keep tokens server-side and revalidate capabilities around provider work", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const accountId = randomUUID();
    const calendarAccountId = randomUUID();
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 3).toString("base64") }),
    );
    let duringAccess: (() => Promise<void>) | undefined;
    let duringFetch: (() => Promise<void>) | undefined;
    let requests = 0;
    const requestCount = () => requests;
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () =>
        Promise.resolve([{ id: "team", summary: "Team", accessRole: "reader" as const }]),
      access: async () => {
        await duringAccess?.();
        return {
          kind: "ready" as const,
          revision: 0,
          grant: {
            accessToken: "provider-secret",
            refreshToken: "synthetic-refresh",
            expiresAt: "2030-01-01T00:00:00.000Z",
            scopes: [...googleScopes.gmail, ...googleScopes.calendar],
          },
        };
      },
      rejected: () => Promise.resolve(),
    };
    const execute = createConnectedReadGateway({
      database,
      google,
      fetch: async (url, init) => {
        requests += 1;
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer provider-secret");
        await duringFetch?.();
        return Response.json(
          url.hostname === "gmail.googleapis.com"
            ? { messages: [{ id: "m1", threadId: "t1" }] }
            : { items: [] },
        );
      },
    });
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const task = await database.transaction(ownerId, async ({ tasks, workspaces }) => {
        await workspaces.register(workspaceId, "Read fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Read fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      for (const [id, service] of [
        [accountId, "gmail"],
        [calendarAccountId, "calendar"],
      ] as const) {
        const connection: Connection = {
          id,
          service,
          subject: id,
          email: `${id}@example.com`,
          scopes: [...googleScopes[service]],
          status: "connected",
          revision: 0,
          calendars: service === "calendar" ? ["team"] : [],
        };
        await vault.put(
          ownerId,
          id,
          {
            accessToken: "provider-secret",
            refreshToken: "synthetic-refresh",
            expiresAt: "2030-01-01T00:00:00.000Z",
            scopes: connection.scopes,
          },
          null,
        );
        await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document) VALUES (${ownerId}::uuid, ${id}::uuid, ${id}, ${service}, ${JSON.stringify(connection)}::text::jsonb)`;
      }
      const issue = () =>
        database.transaction(ownerId, ({ capabilities }) =>
          capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 1,
            taskId: task.id,
            revision: task.revision,
            generation: task.generation,
            operation: "gateway:read",
            credential: null,
          }),
        );
      let capability = await issue();
      const credential = () => ({
        token: capability.token,
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:read" as const,
      });
      const request = {
        version: 1 as const,
        command: "gmail.search" as const,
        accountId,
        query: "fixture",
        limit: 1,
      };
      const signal = new AbortController().signal;
      assert.equal((await execute(credential(), request, signal)).status, "approval_required");
      assert.equal(requestCount(), 0);
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "connection", id: accountId, resource: null },
          operation: "gmail.read",
          decision: "allow",
          revision: 0,
        }),
      );
      const result = await execute(credential(), request, signal);
      assert.equal(result.status, "ok");
      assert.ok(!JSON.stringify(result).includes("provider-secret"));
      assert.equal(requestCount(), 1);
      assert.equal(
        (await execute(credential(), { ...request, accountId: randomUUID() }, signal)).status,
        "unavailable",
      );
      assert.equal(requestCount(), 1);
      assert.equal(
        (
          await execute(
            credential(),
            { version: 1, command: "calendars.list", accountId: calendarAccountId },
            signal,
          )
        ).status,
        "ok",
      );
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "connection", id: calendarAccountId, resource: "team" },
          operation: "calendar.read",
          decision: "allow",
          revision: 1,
        }),
      );
      assert.equal(
        (
          await execute(
            credential(),
            {
              version: 1,
              command: "calendar.events",
              accountId: calendarAccountId,
              calendarId: "team",
              window: {
                timeMin: "2026-11-01T00:00:00Z",
                timeMax: "2026-11-02T00:00:00Z",
                timezone: "UTC",
                query: "",
              },
              limit: 25,
            },
            signal,
          )
        ).status,
        "ok",
      );
      const before = requestCount();
      duringAccess = () =>
        database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(capability.id));
      assert.equal((await execute(credential(), request, signal)).status, "denied");
      assert.equal(requestCount(), before);
      duringAccess = undefined;
      capability = await issue();
      duringFetch = () =>
        database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(capability.id));
      assert.equal((await execute(credential(), request, signal)).status, "denied");
      assert.equal(requestCount(), before + 1);
      assert.equal((await execute(credential(), request, signal)).status, "denied");
      assert.equal(requestCount(), before + 1);
    } finally {
      await database.close();
    }
  });
});
