import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  createCalendarMutationGateway,
  createCalendarReconciliationGateway,
} from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { CliResult } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";
import { parseCommand } from "../../../../apps/cli/src/parse";
import { callGateway } from "../../../../apps/cli/src/gateway";
import { createApi } from "../../../../apps/server/src/http/app";
import { createCliTaskGroup } from "../../../../apps/server/src/http/cli";

test("Calendar RSVP goes through exact read/write approval and never resends uncertainty", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const calendarId = "owner@example.com";
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.calendar],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 12).toString("base64") }),
    );
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () =>
        Promise.resolve([{ id: calendarId, summary: "Personal", accessRole: "owner" as const }]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    const event = {
      id: "event1",
      etag: '"before"',
      summary: "Invitation",
      eventType: "default",
      start: { date: "2026-10-01" },
      end: { date: "2026-10-02" },
      organizer: { email: "host@example.com" },
      attendees: [
        { email: calendarId, self: true, responseStatus: "needsAction" },
        { email: "guest@example.com", responseStatus: "tentative" },
      ],
    };
    let written = false;
    let writes = 0;
    let reads = 0;
    let mode = "success";
    const provider = (url: URL, init: RequestInit) => {
      const after = {
        ...event,
        etag: '"after"',
        attendees: event.attendees.map((guest) =>
          guest.self ? { ...guest, responseStatus: "accepted" } : guest,
        ),
      };
      if (init.method === "GET") {
        reads++;
        return Promise.resolve(Response.json(written ? after : event));
      }
      writes++;
      assert.equal(init.method, "PATCH");
      assert.equal(url.pathname, "/calendar/v3/calendars/owner%40example.com/events/event1");
      assert.equal(url.searchParams.get("sendUpdates"), "all");
      assert.equal(new Headers(init.headers).get("If-Match"), event.etag);
      assert.ok(typeof init.body === "string");
      assert.deepEqual(JSON.parse(init.body), {
        attendeesOmitted: true,
        attendees: [{ email: calendarId, responseStatus: "accepted" }],
      });
      if (mode === "stale") return Promise.resolve(new Response(null, { status: 412 }));
      written = true;
      if (mode === "lost") return Promise.reject(new Error("Lost response"));
      return Promise.resolve(
        Response.json(mode === "mismatch" ? { ...event, etag: '"after"' } : after),
      );
    };
    const options = { database, google, fetch: provider };
    const { app } = createApi({
      groups: {
        task: createCliTaskGroup(database, {
          calendarMutations: createCalendarMutationGateway(options),
          calendarReconciliation: createCalendarReconciliationGateway(options),
        }),
      },
    });
    const task = () =>
      database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "RSVP fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    async function credential(current: Awaited<ReturnType<typeof task>>) {
      const issued = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: current.id,
          revision: current.revision,
          generation: current.generation,
          operation: "gateway:control",
          credential: null,
        }),
      );
      return {
        version: 1 as const,
        environment: "local" as const,
        workspaceId,
        token: `wst_${"r".repeat(43)}`,
        controlToken: issued.token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    }
    async function cli(access: Awaited<ReturnType<typeof credential>>, args: string[]) {
      const parsed = parseCommand(args);
      assert.equal(parsed.kind, "request");
      return callGateway(access, parsed.request, (url, init) =>
        Promise.resolve(app.request(new URL(url).pathname, init)),
      );
    }
    const command = (key = "rsvp") => [
      "calendar",
      "rsvp",
      "--account",
      accountId,
      "--calendar",
      calendarId,
      "--id",
      event.id,
      "--etag",
      event.etag,
      "--scope",
      '{"kind":"single"}',
      "--notify",
      "all",
      "--response",
      "accepted",
      "--key",
      key,
    ];
    async function approve(result: CliResult, current: Awaited<ReturnType<typeof task>>) {
      assert.equal(result.status, "waiting");
      assert.ok(result.referenceId);
      const id = result.referenceId;
      const action = await database.transaction(ownerId, ({ actions }) => actions.find(id));
      assert.ok(action);
      if (action.request.authorization.operation === "calendar.write") {
        const card = await database.transaction(ownerId, ({ telegramApprovals }) =>
          telegramApprovals.prepare(id, 12345),
        );
        assert.ok(card);
        const delivery = await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.claim(12345),
        );
        assert.ok(delivery);
        assert.match(delivery.text, /Respond to Calendar invitation/);
        assert.match(delivery.text, /accepted/);
        assert.match(delivery.text, /host@example.com/);
        await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.settle(delivery, { state: "sent", messageId: 100 + writes }),
        );
      }
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({ id, revision: action.revision, hash: action.hash, approve: true }),
      );
      return database.transaction(ownerId, async ({ tasks }) => {
        const waiting = await tasks.find(current.id);
        assert.ok(waiting);
        const queued = await tasks.resume(waiting.id, waiting.revision, id);
        return tasks.claim(queued.id, queued.revision);
      });
    }
    try {
      await database.transaction(ownerId, async ({ owners, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      await vault.put(ownerId, accountId, grant, null);
      const connection: Connection = {
        id: accountId,
        subject: accountId,
        service: "calendar",
        email: calendarId,
        scopes: grant.scopes,
        status: "connected",
        revision: 0,
        calendars: [calendarId],
      };
      await sql`INSERT INTO winston.google_connections (owner_id,id,subject,service,document) VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'calendar',${JSON.stringify(connection)}::text::jsonb)`;
      await sql`INSERT INTO winston.telegram_bindings (owner_id,bot_id,user_id,chat_id) VALUES (${ownerId}::uuid,12345,123,123)`;
      for (const scenario of ["success", "lost", "mismatch", "stale"]) {
        mode = scenario;
        written = false;
        let current = await task();
        let access = await credential(current);
        const beforeReads = reads;
        const beforeWrites: number = writes;
        const inspection = await cli(access, command());
        assert.equal(reads, beforeReads);
        current = await approve(inspection, current);
        access = await credential(current);
        const mutation = await cli(access, command());
        assert.equal(reads, beforeReads + 1);
        assert.equal(writes, beforeWrites);
        current = await approve(mutation, current);
        access = await credential(current);
        const result = await cli(access, command());
        assert.equal(
          result.status,
          scenario === "success" ? "ok" : scenario === "stale" ? "unavailable" : "unknown",
        );
        assert.equal(writes, beforeWrites + 1);
        assert.equal((await cli(access, command())).status, result.status);
        if (result.status === "unknown") {
          assert.ok(result.referenceId);
          assert.equal((await cli(access, command("replacement"))).status, "unknown");
          const args = ["calendar", "reconcile", "--id", result.referenceId, "--key", "observe"];
          current = await approve(await cli(access, args), current);
          access = await credential(current);
          assert.equal((await cli(access, args)).status, "ok");
        }
        assert.equal(writes, beforeWrites + 1);
      }
    } finally {
      await database.close();
    }
  });
});
