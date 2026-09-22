import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

const registration = {
  platform: "macos" as const,
  appVersion: "0.1.0",
  protocolVersion: 1 as const,
  capabilities: ["command", "file.read"] as ("command" | "file.read")[],
};

test("device pairing is one-time, owner-scoped, revocable and independent of display names", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const owner = randomUUID();
    const other = randomUUID();
    try {
      await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(other, ({ owners }) => owners.ensure());
      const start = () => database.transaction(owner, ({ devices }) => devices.start("MacBook"));
      const pair = (secret: string) =>
        database.transaction(owner, ({ devices }) => devices.pair(secret, registration));
      const abandoned = await start();
      const first = await start();
      assert.equal(await database.authenticateDevicePairing(abandoned.secret), null);
      assert.deepEqual(await database.authenticateDevicePairing(first.secret), { ownerId: owner });
      assert.equal(
        await database.transaction(other, ({ devices }) =>
          devices.pair(first.secret, registration),
        ),
        null,
      );

      const concurrent = await Promise.all([pair(first.secret), pair(first.secret)]);
      const initial = concurrent.find((result) => result !== null);
      assert.ok(initial);
      assert.equal(concurrent.filter((result) => result !== null).length, 1);
      assert.equal(await database.authenticateDevicePairing(first.secret), null);
      assert.equal(await pair(first.secret), null);
      const second = await pair((await start()).secret);
      assert.ok(second);
      assert.equal(second.device.name, initial.device.name);
      assert.notEqual(second.device.id, initial.device.id);
      assert.notEqual(second.credential, initial.credential);
      assert.equal(second.device.isDefault, false);
      assert.deepEqual(await database.authenticateDevice(initial.credential), {
        ownerId: owner,
        deviceId: initial.device.id,
      });
      assert.deepEqual(await database.authenticateDevice(second.credential), {
        ownerId: owner,
        deviceId: second.device.id,
      });
      assert.equal(await database.authenticateDevice(first.secret), null);
      assert.equal(await database.authenticateDevicePairing(initial.credential), null);
      assert.equal(
        await database.authenticateService({
          token: initial.credential,
          kind: "device",
          subjectId: initial.device.id,
          operation: "connector:read",
          resourceId: randomUUID(),
        }),
        null,
      );
      assert.deepEqual(await database.transaction(other, ({ devices }) => devices.list()), []);
      assert.equal(
        await database.transaction(other, ({ devices }) => devices.revoke(initial.device.id, 0)),
        null,
      );
      assert.equal(
        await database.transaction(other, ({ devices }) => devices.find(initial.device.id)),
        null,
      );

      const selected = await database.transaction(owner, ({ devices }) =>
        devices.setDefault(initial.device.id, 0),
      );
      assert.ok(selected?.isDefault);
      await assert.rejects(
        database.transaction(owner, async ({ devices }) => {
          await devices.revoke(initial.device.id, selected.revision);
          throw new Error("injected revocation rollback");
        }),
        /injected revocation rollback/,
      );
      assert.ok(await database.authenticateDevice(initial.credential));
      assert.equal(
        await database.transaction(owner, ({ devices }) =>
          devices.rename(initial.device.id, 0, "Stale"),
        ),
        null,
      );
      const revoked = await database.transaction(owner, ({ devices }) =>
        devices.revoke(initial.device.id, selected.revision),
      );
      assert.ok(revoked?.revoked);
      assert.equal(revoked.isDefault, false);
      assert.equal(await database.authenticateDevice(initial.credential), null);
      assert.ok(await database.authenticateDevice(second.credential));
      assert.equal(
        await database.transaction(owner, ({ devices }) =>
          devices.setDefault(initial.device.id, revoked.revision),
        ),
        null,
      );
      const replacement = await pair((await start()).secret);
      assert.ok(replacement);
      assert.notEqual(replacement.device.id, initial.device.id);
      assert.equal(replacement.device.isDefault, false);
      await Promise.all([
        database.transaction(owner, ({ devices }) =>
          devices.setDefault(second.device.id, second.device.revision),
        ),
        database.transaction(owner, ({ devices }) =>
          devices.setDefault(replacement.device.id, replacement.device.revision),
        ),
      ]);
      const fleet = await database.transaction(owner, ({ devices }) => devices.list());
      assert.equal(fleet.filter((device) => device.isDefault).length, 1);
      const rows = await sql<
        { token_hash: string | null }[]
      >`SELECT token_hash FROM winston.devices`;
      assert.ok(!JSON.stringify(rows).includes(second.credential));
      const grants = await sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM winston.service_capabilities`;
      assert.equal(grants[0]?.count, "0");
      const events = await sql<
        { count: string }[]
      >`SELECT count(*)::text AS count FROM winston.events WHERE type = 'device.revoked'`;
      assert.equal(events[0]?.count, "1");

      const expired = await start();
      await sql`UPDATE winston.device_pairing SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal(await pair(expired.secret), null);
      const canceled = await start();
      await database.transaction(owner, ({ devices }) => devices.cancelPairing(canceled.id));
      assert.equal(await pair(canceled.secret), null);

      const rollback = await start();
      await assert.rejects(
        database.transaction(owner, async ({ devices }) => {
          await devices.pair(rollback.secret, registration);
          throw new Error("injected rollback");
        }),
        /injected rollback/,
      );
      assert.ok(await pair(rollback.secret));
    } finally {
      await database.close();
    }
  });
});
