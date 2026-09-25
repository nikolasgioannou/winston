import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createCalendarMutationGateway, prepareCalendarMutation } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { CalendarMutationInput } from "@winston/contracts/calendar-mutations";
import type { CliResult } from "@winston/contracts/cli";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { withTestPostgres } from "../../src/postgres";

test("Calendar gateway preserves read/write approvals and prevents replacement retries", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const calendarId = "team@example.com";
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.calendar],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 9).toString("base64") }),
    );
    let writable = true;
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () =>
        Promise.resolve([
          {
            id: calendarId,
            summary: "Team",
            accessRole: writable ? ("owner" as const) : ("reader" as const),
          },
        ]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    const signal = new AbortController().signal;
    const event = {
      summary: "Review",
      description: "",
      location: "",
      timing: {
        kind: "all-day" as const,
        start: "2026-10-01",
        end: "2026-10-02",
        timezone: "America/New_York",
      },
      attendees: [],
      recurrence: [],
      transparency: "opaque" as const,
    };
    const create: CalendarMutationInput = {
      key: "meeting",
      intent: { kind: "create", accountId, calendarId, sendUpdates: "none", event },
    };
    const original = {
      id: "event1",
      etag: '"before"',
      eventType: "default",
      summary: "Before",
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
    };
    let reads = 0;
    let writes = 0;
    let provider: (url: URL, init: RequestInit) => Promise<Response> = (url, init) => {
      if (init.method === "GET") {
        reads += 1;
        return Promise.resolve(Response.json(original));
      }
      writes += 1;
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
      assert.ok(body && typeof body === "object");
      if (init.method === "PATCH") {
        assert.equal(new Headers(init.headers).get("If-Match"), original.etag);
        assert.equal(url.pathname.endsWith("/event1"), true);
      }
      return Promise.resolve(Response.json({ ...original, ...body, etag: '"after"' }));
    };
    const gateway = createCalendarMutationGateway({
      database,
      google,
      fetch: (url, init) => provider(url, init),
    });

    async function task() {
      return database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Calendar gateway fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    }
    async function credential(
      current: Awaited<ReturnType<typeof task>>,
      operation: "gateway:read" | "gateway:control" = "gateway:control",
    ): Promise<ServiceRequest> {
      const issued = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: current.id,
          revision: current.revision,
          generation: current.generation,
          operation,
          credential: null,
        }),
      );
      return {
        token: issued.token,
        kind: "workspace",
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation,
      };
    }
    async function approve(
      result: CliResult,
      current: Awaited<ReturnType<typeof task>>,
      approve = true,
    ) {
      assert.equal(result.status, "waiting");
      assert.ok(result.referenceId);
      const referenceId = result.referenceId;
      const prepared = await database.transaction(ownerId, ({ actions }) =>
        actions.find(referenceId),
      );
      assert.ok(prepared);
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: prepared.id,
          revision: prepared.revision,
          hash: prepared.hash,
          approve,
        }),
      );
      return database.transaction(ownerId, async ({ tasks }) => {
        const waiting = await tasks.find(current.id);
        assert.ok(waiting);
        const queued = await tasks.resume(waiting.id, waiting.revision, referenceId);
        return tasks.claim(queued.id, queued.revision);
      });
    }

    try {
      await database.transaction(ownerId, async ({ owners, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Gateway fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      await vault.put(ownerId, accountId, grant, null);
      const connection: Connection = {
        id: accountId,
        subject: accountId,
        service: "calendar",
        email: "owner@example.com",
        scopes: grant.scopes,
        status: "connected",
        revision: 0,
        calendars: [calendarId],
      };
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'calendar', ${JSON.stringify(connection)}::text::jsonb)`;
      let current = await task();
      assert.equal(
        (await gateway(await credential(current, "gateway:read"), create, signal)).status,
        "denied",
      );
      let access = await credential(current);
      const waiting = await gateway(access, create, signal);
      assert.equal(writes, 0);
      assert.equal(reads, 0);
      current = await approve(waiting, current);
      assert.equal((await gateway(access, create, signal)).status, "denied");
      access = await credential(current);
      const completed = await gateway(access, create, signal);
      assert.equal(completed.status, "ok");
      assert.equal(writes, 1);
      assert.deepEqual(await gateway(access, create, signal), completed);
      assert.equal(writes, 1);
      assert.equal(
        (
          await gateway(
            access,
            { ...create, intent: { ...create.intent, sendUpdates: "all" } },
            signal,
          )
        ).status,
        "unavailable",
      );
      assert.equal(writes, 1);

      current = await task();
      access = await credential(current);
      const update: CalendarMutationInput = {
        key: "update-meeting",
        intent: {
          kind: "update",
          accountId,
          calendarId,
          eventId: original.id,
          etag: original.etag,
          scope: { kind: "single" },
          changes: { summary: "After" },
          sendUpdates: "all",
        },
      };
      const inspectWait = await gateway(access, update, signal);
      assert.equal(reads, 0);
      current = await approve(inspectWait, current);
      access = await credential(current);
      const mutationWait = await gateway(access, update, signal);
      assert.equal(mutationWait.status, "waiting");
      assert.equal(reads, 1);
      assert.equal(writes, 1);
      current = await approve(mutationWait, current);
      access = await credential(current);
      assert.equal((await gateway(access, update, signal)).status, "ok");
      assert.equal(reads, 1);
      assert.equal(writes, 2);

      current = await task();
      access = await credential(current);
      const rejected = await gateway(access, create, signal);
      current = await approve(rejected, current, false);
      assert.equal((await gateway(await credential(current), create, signal)).status, "denied");
      assert.equal(writes, 2);

      current = await task();
      access = await credential(current);
      const roleWait = await gateway(access, create, signal);
      current = await approve(roleWait, current);
      writable = false;
      assert.equal(
        (await gateway(await credential(current), create, signal)).status,
        "unavailable",
      );
      assert.equal(writes, 2);
      writable = true;

      current = await task();
      access = await credential(current);
      const stale: CalendarMutationInput = {
        key: "stale-event",
        intent: {
          kind: "delete",
          accountId,
          calendarId,
          eventId: original.id,
          etag: '"old-version"',
          scope: { kind: "single" },
          sendUpdates: "none",
        },
      };
      current = await approve(await gateway(access, stale, signal), current);
      assert.equal((await gateway(await credential(current), stale, signal)).status, "unavailable");
      assert.equal(writes, 2);

      // Enable automatic Calendar writes for synthetic concurrency fixtures.
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          revision: 0,
          target: { kind: "connection", id: accountId, resource: calendarId },
          operation: "calendar.write",
          decision: "allow",
        }),
      );
      current = await task();
      access = await credential(current);
      // A surrounding workspace command is expected during a real CLI invocation.
      await database.transaction(ownerId, async ({ actions }) => {
        const outer = await actions.prepare({
          key: randomUUID(),
          task: { id: current.id, revision: current.revision, generation: current.generation },
          authorization: {
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.command",
          },
          arguments: { command: "winston calendar create" },
        });
        assert.equal(
          (await actions.claim(outer.id, outer.hash, outer.request.task))?.claimed,
          true,
        );
      });
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let uncertainCalls = 0;
      provider = async () => {
        uncertainCalls += 1;
        started.resolve(undefined);
        await release.promise;
        throw new Error("Lost response");
      };
      const first = gateway(access, create, signal);
      await started.promise;
      try {
        const blocked = await gateway(access, { ...create, key: "replacement" }, signal);
        assert.equal(blocked.status, "unknown");
        assert.equal(uncertainCalls, 1);
      } finally {
        release.resolve(undefined);
      }
      const unknown = await first;
      assert.equal(unknown.status, "unknown");
      assert.equal(
        (await gateway(access, { ...create, key: "replacement-again" }, signal)).status,
        "unknown",
      );
      assert.equal(uncertainCalls, 1);

      // Both plans may be prepared before either is claimed; claiming must fence them too.
      current = await task();
      const worker = { id: current.id, revision: current.revision, generation: current.generation };
      const target = {
        connectionId: accountId,
        calendarId,
        operation: "calendar.write" as const,
        connectionRevision: 0,
        preferencesRevision: 0,
        email: connection.email,
        label: "Team",
        task: { id: worker.id, revision: worker.revision },
      };
      await database.transaction(ownerId, ({ connectionTargets }) =>
        connectionTargets.bind(
          {
            operation: target.operation,
            task: target.task,
            explicit: { connectionId: accountId, calendarId },
          },
          { connectionId: accountId, calendarId },
        ),
      );
      const make = (key: string) =>
        database.transaction(ownerId, ({ calendarActions }) =>
          calendarActions.prepare(
            worker,
            key,
            create.intent,
            prepareCalendarMutation(randomUUID(), {
              kind: "create",
              target,
              event,
              sendUpdates: "none",
            }),
          ),
        );
      const one = await make("one");
      const two = await make("two");
      await database.transaction(ownerId, ({ actions }) => actions.claim(one.id, one.hash, worker));
      await assert.rejects(
        database.transaction(ownerId, ({ actions }) => actions.claim(two.id, two.hash, worker)),
        /remains unresolved/,
      );
    } finally {
      await database.close();
    }
  });
});
