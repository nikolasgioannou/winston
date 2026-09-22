import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createConnectionTargets, labelSearchResults } from "@winston/adapters/google";
import { googleScopes, type Connection, type GoogleCalendar } from "@winston/contracts/connections";
import type { TargetSelection } from "@winston/contracts/connection-targets";
import { withTestPostgres } from "../../src/postgres";

test("target resolution isolates senders, binds task revisions and never substitutes unavailable accounts", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const stranger = randomUUID();
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", {
        test: Buffer.alloc(32, 2).toString("base64"),
      }),
    );
    const inventory = new Map<string, GoogleCalendar[]>();
    const targets = createConnectionTargets(database, {
      list: (id) => database.transaction(id, (scope) => scope.connections.list()),
      calendars: (_owner, id) => Promise.resolve(inventory.get(id) ?? []),
    });
    const signal = new AbortController().signal;
    const resolve = (selection: TargetSelection) => targets.resolve(owner, selection, signal);
    async function connect(service: "gmail" | "calendar") {
      const id = randomUUID();
      const connection: Connection = {
        id,
        service,
        subject: id,
        email: `${id}@example.com`,
        scopes: [...googleScopes[service]],
        status: "connected",
        revision: 0,
        calendars: service === "calendar" ? ["one", "two", "deleted", "busy"] : [],
      };
      await vault.put(
        owner,
        id,
        {
          accessToken: "synthetic",
          refreshToken: "synthetic",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: connection.scopes,
        },
        null,
      );
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${owner}::uuid, ${id}::uuid, ${id}, ${service}, ${JSON.stringify(connection)}::text::jsonb)`;
      return { connectionId: id, calendarId: null };
    }
    try {
      await database.transaction(owner, (scope) => scope.owners.ensure());
      await database.transaction(stranger, (scope) => scope.owners.ensure());
      const first = await connect("gmail");
      const second = await connect("gmail");
      const calendar = await connect("calendar");
      inventory.set(calendar.connectionId, [
        { id: "one", summary: "Personal", accessRole: "writer" },
        { id: "two", summary: "Shared", accessRole: "reader" },
        { id: "deleted", accessRole: "owner", deleted: true },
        { id: "busy", accessRole: "freeBusyReader" },
      ]);
      assert.equal((await resolve({ operation: "gmail.send" })).status, "choose");
      const search = await targets.searchTargets(owner, "gmail.read", signal);
      assert.equal(search.length, 2);
      const source = search[0];
      assert.ok(source);
      const sourced = labelSearchResults(source, [{ id: "message" }]);
      assert.equal(sourced[0]?.source.connectionId, search[0]?.connectionId);
      assert.equal((await resolve({ operation: "gmail.send" })).status, "choose");
      const preferences = await database.transaction(owner, (scope) =>
        scope.connectionTargets.put({
          revision: 0,
          labels: [
            { target: first, label: "Personal" },
            {
              target: { ...calendar, calendarId: "one" },
              label: "Home",
            },
          ],
          defaults: [{ operation: "gmail.read", target: first }],
        }),
      );
      assert.ok(preferences);
      assert.equal((await resolve({ operation: "gmail.send" })).status, "choose");
      const preferred = await resolve({ operation: "gmail.read" });
      assert.equal(preferred.status, "resolved");
      assert.equal(preferred.target.connectionId, first.connectionId);
      assert.equal(preferred.target.label, "Personal");
      const explicit = await resolve({ operation: "gmail.read", explicit: second });
      assert.equal(explicit.status, "resolved");
      assert.equal(explicit.target.connectionId, second.connectionId);
      assert.equal(
        await database.transaction(owner, (scope) =>
          scope.connectionTargets.put({
            ...preferences,
            revision: 0,
          }),
        ),
        null,
      );
      await assert.rejects(
        database.transaction(stranger, (scope) =>
          scope.connectionTargets.put({
            revision: 0,
            labels: [],
            defaults: [{ operation: "gmail.send", target: first }],
          }),
        ),
      );
      assert.equal(
        (await targets.resolve(stranger, { operation: "gmail.send", explicit: first }, signal))
          .status,
        "unavailable",
      );
      const calendarWrite = await resolve({ operation: "calendar.write" });
      assert.equal(calendarWrite.status, "resolved");
      assert.equal(calendarWrite.target.calendarId, "one");
      assert.ok(calendarWrite.target.label.endsWith(" · Home"));
      assert.equal((await resolve({ operation: "calendar.read" })).status, "choose");
      assert.equal(
        (
          await resolve({
            operation: "calendar.write",
            explicit: { ...calendar, calendarId: "two" },
          })
        ).status,
        "unavailable",
      );
      assert.equal(
        (
          await resolve({
            operation: "calendar.read",
            explicit: { ...calendar, calendarId: "deleted" },
          })
        ).status,
        "unavailable",
      );
      inventory.set(calendar.connectionId, [{ id: "one", accessRole: "reader" }]);
      assert.equal(await targets.revalidate(owner, calendarWrite.target, signal), false);

      const task = await database.transaction(owner, (scope) =>
        scope.tasks.create({
          key: "target-fixture",
          objective: "Draft a message",
          sourceMessageIds: [],
        }),
      );
      const selection: TargetSelection = {
        operation: "gmail.draft",
        explicit: first,
        task: { id: task.id, revision: task.revision },
      };
      const bound = await resolve(selection);
      assert.equal(bound.status, "resolved");
      assert.equal(await targets.revalidate(owner, bound.target, signal), true);
      await assert.rejects(resolve({ ...selection, explicit: second }));
      const steered = await database.transaction(owner, (scope) =>
        scope.tasks.steer(task.id, task.revision, "Use my other account"),
      );
      assert.equal(await targets.revalidate(owner, bound.target, signal), false);
      assert.equal(
        (
          await resolve({
            ...selection,
            explicit: second,
            task: { id: task.id, revision: steered.revision },
          })
        ).status,
        "resolved",
      );
      await vault.revoke(owner, first.connectionId, 0);
      assert.equal((await resolve({ operation: "gmail.read" })).status, "unavailable");
      assert.equal(await targets.revalidate(owner, preferred.target, signal), false);
      assert.equal((await targets.searchTargets(owner, "gmail.read", signal)).length, 1);
      assert.equal(
        (await resolve({ operation: "gmail.send", explicit: first })).status,
        "unavailable",
      );
    } finally {
      await database.close();
    }
  });
});
