import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  authorizationEvaluationSchema,
  type AuthorizationRequest,
  type AuthorizationUpdate,
} from "@winston/contracts/authorization";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("authorization versions fence queued actions and isolate account, calendar and device permissions", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const stranger = randomUUID();
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 1).toString("base64") }),
    );
    const evaluate = (request: AuthorizationRequest) =>
      database.transaction(owner, ({ authorization }) => authorization.evaluate(request));
    const put = (input: AuthorizationUpdate) =>
      database.transaction(owner, ({ authorization }) => authorization.put(input));

    async function connect(service: "gmail" | "calendar") {
      const id = randomUUID();
      const connection: Connection = {
        id,
        service,
        subject: id,
        email: "fixture@example.com",
        scopes: [...googleScopes[service]],
        status: "connected",
        revision: 0,
        calendars: service === "calendar" ? ["personal", "shared"] : [],
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
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document) VALUES (${owner}::uuid, ${id}::uuid, ${id}, ${service}, ${JSON.stringify(connection)}::text::jsonb)`;
      return id;
    }

    async function pair() {
      const challenge = await database.transaction(owner, ({ devices }) =>
        devices.start("Fixture"),
      );
      const device = await database.transaction(owner, ({ devices }) =>
        devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command", "file.read"],
        }),
      );
      assert.ok(device);
      return device.device;
    }

    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const first = await pair();
      const second = await pair();
      const command: AuthorizationRequest = {
        target: { kind: "device", id: first.id, resource: null },
        operation: "device.command",
      };
      assert.equal((await evaluate(command)).decision, "ask");
      assert.deepEqual(await put({ ...command, decision: "allow", revision: 0 }), { revision: 1 });
      const approved = authorizationEvaluationSchema.parse(await evaluate(command));
      assert.equal(approved.decision, "allow");
      assert.equal(approved.broadAuthority, true);
      assert.ok(approved.snapshot);
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate({ ...command, trigger: "schedule", decision: "allow" }),
          )
        ).decision,
        "deny",
      );
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate(
              { ...command, target: { ...command.target, id: second.id } },
              approved.snapshot ?? undefined,
            ),
          )
        ).reason,
        "stale",
      );
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate(
              { ...command, operation: "device.file.read" },
              approved.snapshot ?? undefined,
            ),
          )
        ).reason,
        "stale",
      );
      assert.equal(
        await database.transaction(stranger, ({ authorization }) =>
          authorization.put({ ...command, decision: "allow", revision: 0 }),
        ),
        null,
      );
      assert.equal(
        (
          await database.transaction(stranger, ({ authorization }) =>
            authorization.evaluate(command),
          )
        ).decision,
        "deny",
      );
      assert.deepEqual(
        await database.transaction(stranger, ({ authorization }) => authorization.list()),
        { revision: 0, rules: [] },
      );
      assert.deepEqual(await put({ ...command, decision: "ask", revision: 1 }), { revision: 2 });
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate(command, approved.snapshot ?? undefined),
          )
        ).reason,
        "stale",
      );
      assert.equal((await evaluate(command)).decision, "ask");
      assert.equal(await put({ ...command, decision: "allow", revision: 1 }), null);
      assert.deepEqual(await put({ ...command, decision: "deny", revision: 2 }), { revision: 3 });
      assert.equal((await evaluate(command)).decision, "deny");

      const calendarId = await connect("calendar");
      const account: AuthorizationRequest = {
        target: { kind: "connection", id: calendarId, resource: null },
        operation: "calendar.write",
      };
      const personal = { ...account, target: { ...account.target, resource: "personal" } };
      const shared = { ...account, target: { ...account.target, resource: "shared" } };
      assert.deepEqual(await put({ ...account, decision: "allow", revision: 3 }), { revision: 4 });
      assert.equal((await evaluate(account)).decision, "deny");
      assert.equal((await evaluate(personal)).decision, "allow");
      const calendarSnapshot = (await evaluate(personal)).snapshot;
      assert.ok(calendarSnapshot);
      await database.transaction(owner, ({ connections }) =>
        connections.selectCalendars(calendarId, 0, ["personal", "shared", "extra"]),
      );
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate(personal, calendarSnapshot),
          )
        ).reason,
        "stale",
      );
      assert.deepEqual(await put({ ...shared, decision: "ask", revision: 4 }), { revision: 5 });
      assert.equal((await evaluate(shared)).decision, "ask");
      assert.deepEqual(await put({ ...shared, decision: "allow", revision: 5 }), { revision: 6 });
      assert.deepEqual(await put({ ...account, decision: "deny", revision: 6 }), { revision: 7 });
      assert.equal((await evaluate(shared)).decision, "deny");
      assert.equal(
        (await evaluate({ ...shared, target: { ...shared.target, resource: "unknown" } })).decision,
        "deny",
      );
      await database.transaction(owner, ({ connections }) =>
        connections.selectCalendars(calendarId, 1, ["personal"]),
      );
      assert.equal((await evaluate(shared)).reason, "unavailable");

      const gmailId = await connect("gmail");
      const read: AuthorizationRequest = {
        target: { kind: "connection", id: gmailId, resource: null },
        operation: "gmail.read",
      };
      assert.deepEqual(await put({ ...read, decision: "allow", revision: 7 }), { revision: 8 });
      assert.equal((await evaluate(read)).decision, "allow");
      assert.equal((await evaluate({ ...read, operation: "gmail.send" })).decision, "ask");
      await vault.revoke(owner, gmailId, 0);
      assert.equal((await evaluate(read)).decision, "deny");
      assert.deepEqual(await put({ ...read, decision: "deny", revision: 8 }), { revision: 9 });
      assert.equal(await put({ ...read, decision: "allow", revision: 9 }), null);
      assert.equal(
        (
          await database.transaction(owner, ({ authorization }) =>
            authorization.evaluate({ ...read, operation: "gmail.future" }),
          )
        ).reason,
        "unsupported",
      );
      await database.transaction(owner, ({ devices }) => devices.revoke(first.id, 0));
      assert.equal((await evaluate(command)).reason, "unavailable");
      const concurrent = await Promise.all([
        put({ ...command, decision: "ask", revision: 9 }),
        put({ ...read, decision: "deny", revision: 9 }),
      ]);
      assert.equal(concurrent.filter((result) => result !== null).length, 1);
      const persisted = await database.transaction(owner, ({ authorization }) =>
        authorization.list(),
      );
      assert.equal(persisted.revision, 10);
    } finally {
      await database.close();
    }
  });
});
