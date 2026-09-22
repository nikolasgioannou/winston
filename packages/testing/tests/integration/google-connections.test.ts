import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createGoogleConnections } from "@winston/adapters/google";
import {
  googleScopes,
  type GoogleGrant,
  type ConnectionStart,
} from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("Google connections preserve independent accounts, bind one-time state and reject account replacement", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const cipher = createCredentialCipher("fixture", {
      fixture: Buffer.alloc(32, 7).toString("base64"),
    });
    const vault = createCredentialVault(database, cipher);
    let exchanges = 0;
    let grant: GoogleGrant = {
      subject: "account-a",
      email: "a@example.com",
      accessToken: "access-canary",
      refreshToken: "refresh-canary",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [...googleScopes.gmail],
    };
    const store = createGoogleConnections({
      database,
      cipher,
      oauth: {
        refresh: (current) => Promise.resolve(current),
        url: (_service, state) => `https://accounts.google.com/?state=${state}`,
        exchange: () => {
          exchanges += 1;
          return Promise.resolve(grant);
        },
      },
      calendars: () =>
        Promise.resolve([{ id: "calendar-a", summary: "Personal", accessRole: "owner" }]),
    });
    const start = async (intent: ConnectionStart) => {
      const result = await store.start(ownerId, "session", intent);
      const state = new URL(result.url).searchParams.get("state");
      assert.ok(state);
      return state;
    };
    const finish = (state: string) =>
      store.finish(ownerId, "session", state, "fixture-code", new AbortController().signal);
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const first = await start({ service: "gmail" });
      await assert.rejects(
        store.finish(stranger, "session", first, "fixture", new AbortController().signal),
        /invalid or expired/,
      );
      await assert.rejects(
        store.finish(ownerId, "other-session", first, "fixture", new AbortController().signal),
        /invalid or expired/,
      );
      assert.equal(exchanges, 0);
      const a = await finish(first);
      assert.equal(a.status, "connected");
      await assert.rejects(finish(first), /invalid or expired/);
      assert.equal(exchanges, 1);
      grant = {
        ...grant,
        subject: "account-b",
        email: "b@example.com",
        refreshToken: "independent-refresh-canary",
      };
      const b = await finish(await start({ service: "gmail" }));
      assert.notEqual(a.id, b.id);
      assert.equal((await store.list(ownerId)).length, 2);
      assert.deepEqual(await store.list(stranger), []);
      const loginUsers = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston_auth.users`;
      assert.equal(loginUsers[0]?.count, 0, "Connector accounts never create app login users");
      await assert.rejects(
        finish(await start({ service: "gmail", connectionId: a.id })),
        /original Google account/,
      );
      assert.deepEqual(
        (await store.list(ownerId)).find((item) => item.id === a.id),
        a,
      );

      delete grant.refreshToken;
      grant = { ...grant, subject: "account-a", email: "renamed@example.com" };
      const reconnected = await finish(await start({ service: "gmail", connectionId: a.id }));
      assert.equal(reconnected.id, a.id);
      assert.equal((await vault.read(ownerId, a.id))?.grant.refreshToken, "refresh-canary");
      assert.equal(
        (await vault.read(ownerId, b.id))?.grant.refreshToken,
        "independent-refresh-canary",
      );
      grant = {
        ...grant,
        refreshToken: "calendar-refresh-canary",
        scopes: [...googleScopes.calendar],
      };
      const calendar = await finish(await start({ service: "calendar" }));
      assert.notEqual(calendar.id, a.id);
      const selected = await store.selectCalendars(
        ownerId,
        calendar.id,
        calendar.revision,
        ["calendar-a"],
        new AbortController().signal,
      );
      assert.deepEqual(selected.calendars, ["calendar-a"]);
      await assert.rejects(
        store.selectCalendars(
          ownerId,
          calendar.id,
          selected.revision,
          ["other-account-calendar"],
          new AbortController().signal,
        ),
        /unavailable/,
      );
      await assert.rejects(
        store.calendars(stranger, calendar.id, new AbortController().signal),
        /unavailable/,
      );
      const expired = await start({ service: "gmail" });
      await sql`UPDATE winston.google_challenges SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      await assert.rejects(finish(expired), /invalid or expired/);
      grant = { ...grant, subject: "account-c", email: "c@example.com", scopes: ["openid"] };
      assert.equal((await finish(await start({ service: "gmail" }))).status, "limited");
      const rows = await sql<{ encrypted: unknown }[]>`SELECT encrypted FROM winston.credentials`;
      assert.ok(!JSON.stringify(rows).includes("canary"));

      const task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "connection-task",
          objective: "Connect Gmail",
          sourceMessageIds: [],
        });
        const running = await tasks.claim(queued.id, queued.revision);
        return tasks.finishStep(running.id, running.revision, running.generation, {
          state: "waiting",
          blocker: { kind: "connection", referenceId: randomUUID(), detail: "Connect Gmail" },
        });
      });
      assert.ok(task.blocker);
      const waiting = await start({
        service: "gmail",
        task: { id: task.id, revision: task.revision, blockerId: task.blocker.referenceId },
      });
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      grant = {
        ...grant,
        subject: "account-d",
        email: "d@example.com",
        scopes: [...googleScopes.gmail],
      };
      const connected = await finish(waiting);
      const event = await sql<
        { payload: Record<string, unknown> }[]
      >`SELECT payload FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'connection.connected' AND payload->>'connectionId' = ${connected.id}`;
      assert.equal(
        event[0]?.payload.task,
        undefined,
        "A canceled waiting task cannot be resumed by an old connection callback",
      );
    } finally {
      await database.close();
    }
  });
});
