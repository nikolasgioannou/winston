import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createCalendarMutationExecutor, prepareCalendarMutation } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { ActionTask } from "@winston/contracts/actions";
import { withTestPostgres } from "../../src/postgres";

test("Calendar dispatch sends exact approved writes once and preserves uncertain outcomes", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const calendarId = "team@example.com";
    const grant = {
      accessToken: "synthetic-secret",
      refreshToken: "synthetic-refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.calendar],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 8).toString("base64") }),
    );
    let credentialRevision = 0;
    let canWrite = true;
    let rejected = 0;
    const google = {
      list: (id: string) => database.transaction(id, ({ connections }) => connections.list()),
      calendars: () =>
        Promise.resolve([
          {
            id: calendarId,
            summary: "Team",
            accessRole: canWrite ? ("owner" as const) : ("reader" as const),
          },
        ]),
      access: () =>
        Promise.resolve({ kind: "ready" as const, grant, revision: credentialRevision }),
      rejected: () => {
        rejected += 1;
        return Promise.resolve();
      },
    };
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
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
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          revision: 0,
          target: { kind: "connection", id: accountId, resource: calendarId },
          operation: "calendar.write",
          decision: "allow",
        }),
      );

      async function prepare(kind: "create" | "update" | "delete" = "create") {
        const task = await database.transaction(ownerId, async ({ tasks }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Calendar fixture",
            sourceMessageIds: [],
          });
          return tasks.claim(queued.id, queued.revision);
        });
        const worker: ActionTask = {
          id: task.id,
          revision: task.revision,
          generation: task.generation,
        };
        const target = {
          connectionId: accountId,
          calendarId,
          operation: "calendar.write" as const,
          connectionRevision: 0,
          preferencesRevision: 0,
          label: "Team",
          email: connection.email,
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
        const event = {
          summary: "Review",
          description: "",
          location: "",
          timing: {
            kind: "all-day",
            start: "2026-10-01",
            end: "2026-10-02",
            timezone: "America/New_York",
          },
          attendees: [],
          recurrence: [],
          transparency: "opaque",
        };
        const details =
          kind === "create"
            ? { kind, event, sendUpdates: "none" }
            : {
                kind,
                eventId: "instance1",
                etag: '"before"',
                sendUpdates: "all",
                scope: {
                  kind: "instance",
                  recurringEventId: "series1",
                  originalStartTime: { date: "2026-10-01" },
                },
                ...(kind === "update" ? { changes: { summary: "Updated" } } : {}),
              };
        const snapshot =
          kind === "create"
            ? undefined
            : {
                source: { ...target, operation: "calendar.read" },
                event: {
                  id: "instance1",
                  etag: '"before"',
                  eventType: "default",
                  summary: "Before",
                  recurringEventId: "series1",
                  originalStartTime: { date: "2026-10-01" },
                  start: { date: "2026-10-01" },
                  end: { date: "2026-10-02" },
                },
              };
        const plan = prepareCalendarMutation(randomUUID(), { ...details, target }, snapshot);
        const action = await database.transaction(ownerId, ({ calendarActions }) =>
          calendarActions.prepare(
            worker,
            randomUUID(),
            {
              ...details,
              accountId,
              calendarId,
            },
            plan,
          ),
        );
        assert.equal(action.state, "approved");
        return { worker, plan, action };
      }

      for (const kind of ["create", "update", "delete"] as const) {
        const { worker, plan, action } = await prepare(kind);
        let calls = 0;
        const execute = createCalendarMutationExecutor({
          database,
          google,
          fetch: async (url, init) => {
            calls += 1;
            assert.equal(url.origin, "https://www.googleapis.com");
            assert.equal(url.pathname, `/calendar/v3/${plan.path}`);
            assert.equal(url.searchParams.get("sendUpdates"), plan.sendUpdates);
            assert.equal(init.method, plan.method);
            assert.equal(init.redirect, "error");
            assert.equal(new Headers(init.headers).get("If-Match"), plan.ifMatch);
            assert.deepEqual(
              typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
              plan.body ?? undefined,
            );
            // Verify the exclusive claim is visible to another transaction before network I/O.
            assert.equal(
              (await database.transaction(ownerId, ({ actions }) => actions.find(action.id)))
                ?.state,
              "dispatching",
            );
            return kind === "delete"
              ? new Response(null, { status: 204 })
              : Response.json({
                  id: plan.eventId,
                  etag: '"after"',
                  start: { date: "2026-10-01" },
                  end: { date: "2026-10-02" },
                });
          },
        });
        const result = await execute(
          ownerId,
          action.id,
          action.hash,
          worker,
          new AbortController().signal,
        );
        assert.equal(result?.state, "succeeded");
        assert.equal(result.outcome?.providerReference, plan.eventId);
        assert.equal(
          (await execute(ownerId, action.id, action.hash, worker, new AbortController().signal))
            ?.state,
          "succeeded",
        );
        assert.equal(calls, 1);
      }

      const concurrent = await prepare();
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      let concurrentCalls = 0;
      const exclusive = createCalendarMutationExecutor({
        database,
        google,
        fetch: async () => {
          concurrentCalls += 1;
          started.resolve(undefined);
          await release.promise;
          throw new Error("Lost response after possible creation.");
        },
      });
      const first = exclusive(
        ownerId,
        concurrent.action.id,
        concurrent.action.hash,
        concurrent.worker,
        new AbortController().signal,
      );
      await started.promise;
      try {
        const second = await exclusive(
          ownerId,
          concurrent.action.id,
          concurrent.action.hash,
          concurrent.worker,
          new AbortController().signal,
        );
        assert.equal(second?.state, "dispatching");
        assert.equal(concurrentCalls, 1);
      } finally {
        release.resolve(undefined);
      }
      assert.equal((await first)?.state, "unknown");

      for (const status of [400, 401, 403, 404, 409, 410, 412, 429, 500]) {
        const { worker, action } = await prepare("update");
        let calls = 0;
        const execute = createCalendarMutationExecutor({
          database,
          google,
          fetch: () => {
            calls += 1;
            return Promise.resolve(new Response("synthetic-secret provider details", { status }));
          },
        });
        const result = await execute(
          ownerId,
          action.id,
          action.hash,
          worker,
          new AbortController().signal,
        );
        assert.equal(result?.state, [409, 500].includes(status) ? "unknown" : "failed");
        assert.equal(JSON.stringify(result.outcome).includes("synthetic-secret"), false);
        await execute(ownerId, action.id, action.hash, worker, new AbortController().signal);
        assert.equal(calls, 1);
      }
      assert.equal(rejected, 1);

      for (const mode of [
        "lost",
        "malformed",
        "wrong-event",
        "oversized",
        "cancel-during-send",
      ] as const) {
        const { worker, action, plan } = await prepare();
        let calls = 0;
        const execute = createCalendarMutationExecutor({
          database,
          google,
          fetch: async () => {
            calls += 1;
            if (mode === "lost") throw new Error("synthetic-secret");
            if (mode === "malformed") return new Response("not json");
            if (mode === "oversized") return new Response("x".repeat(1_000_001));
            if (mode === "cancel-during-send")
              await database.transaction(ownerId, ({ tasks }) =>
                tasks.cancel(worker.id, worker.revision),
              );
            return Response.json({
              id: mode === "wrong-event" ? "other" : plan.eventId,
              etag: '"after"',
              start: { date: "2026-10-01" },
              end: { date: "2026-10-02" },
            });
          },
        });
        const result = await execute(
          ownerId,
          action.id,
          action.hash,
          worker,
          new AbortController().signal,
        );
        assert.equal(result?.state, mode === "cancel-during-send" ? "succeeded" : "unknown");
        await execute(ownerId, action.id, action.hash, worker, new AbortController().signal);
        assert.equal(calls, 1);
      }

      for (const mode of ["credentials", "read-only", "canceled", "aborted"] as const) {
        const { worker, action } = await prepare();
        let calls = 0;
        credentialRevision = mode === "credentials" ? 99 : 0;
        canWrite = mode !== "read-only";
        if (mode === "canceled")
          await database.transaction(ownerId, ({ tasks }) =>
            tasks.cancel(worker.id, worker.revision),
          );
        const controller = new AbortController();
        if (mode === "aborted") controller.abort();
        const execute = createCalendarMutationExecutor({
          database,
          google,
          fetch: () => {
            calls += 1;
            return Promise.resolve(Response.json({}));
          },
        });
        const result = await execute(ownerId, action.id, action.hash, worker, controller.signal);
        assert.equal(result?.state ?? null, mode === "canceled" ? null : "failed");
        assert.equal(calls, 0);
      }
    } finally {
      await database.close();
    }
  });
});
