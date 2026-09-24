import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import type { DeviceSessionIdentity } from "@winston/contracts/device-registry";
import { withTestPostgres } from "../../src/postgres";

test("session capabilities require a fresh live advertisement and explicit readiness", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const paired = await database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Capabilities fixture");
        const result = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(result);
        return result;
      });
      const open = async () => {
        const result = await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.open(paired.device.id, paired.credential),
        );
        assert.ok(result);
        return {
          deviceId: result.deviceId,
          sessionId: result.sessionId,
          generation: result.generation,
        };
      };
      const supports = (session: DeviceSessionIdentity, capability = "command", owner = ownerId) =>
        database.transaction(owner, ({ deviceSessions }) =>
          deviceSessions.supports(session, capability),
        );
      const advertise = (session: DeviceSessionIdentity, capabilities: string[], owner = ownerId) =>
        database.transaction(owner, ({ deviceSessions }) =>
          deviceSessions.advertise(session, capabilities),
        );
      const heartbeat = (session: DeviceSessionIdentity, status: string) =>
        database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(session, status),
        );
      const first = await open();
      assert.equal(await heartbeat(first, "ready"), true);
      assert.equal(await supports(first), false);
      assert.equal(await advertise(first, ["file.read", "command"]), true);
      assert.equal(await supports(first), true);
      assert.equal(await supports(first, "input"), false);
      const updated = await database.transaction(ownerId, ({ devices }) =>
        devices.find(paired.device.id),
      );
      assert.equal(updated?.revision, paired.device.revision + 1);
      assert.deepEqual(updated.capabilities, ["command", "file.read"]);
      assert.equal(await advertise(first, ["command", "file.read"]), true);
      assert.deepEqual(
        await database.transaction(ownerId, ({ devices }) => devices.find(paired.device.id)),
        updated,
      );
      assert.equal(await advertise(first, [], other), false);
      assert.equal(await supports(first, "command", other), false);
      await assert.rejects(() => advertise(first, ["command", "command"]));
      await assert.rejects(() => advertise(first, ["invalid"]));
      assert.equal(await advertise(first, []), true);
      assert.equal(await supports(first), false);
      assert.equal(await advertise(first, ["command"]), true);

      const second = await open();
      assert.equal(await advertise(first, ["input"]), false);
      assert.equal(await supports(first), false);
      assert.equal(await heartbeat(second, "ready"), true);
      assert.equal(await supports(second), false);
      assert.equal(await advertise(second, ["command"]), true);
      for (const status of ["paused", "locked", "sleeping"]) {
        assert.equal(await heartbeat(second, status), true);
        assert.equal(await supports(second), false);
      }
      assert.equal(await heartbeat(second, "ready"), true);
      assert.equal(await supports(second), true);
      const before = await sql<
        { lease: string }[]
      >`SELECT lease_until::text AS lease FROM winston.device_sessions WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await advertise(second, ["command", "file.read"]), true);
      const after = await sql<
        { lease: string }[]
      >`SELECT lease_until::text AS lease FROM winston.device_sessions WHERE owner_id = ${ownerId}::uuid`;
      assert.deepEqual(after, before);
      await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await supports(second), false);
      assert.equal(await advertise(second, ["command"]), false);

      const third = await open();
      assert.equal(await advertise(third, ["command"]), true);
      assert.equal(await heartbeat(third, "ready"), true);
      assert.equal(await supports(third), true);
      const current = await database.transaction(ownerId, ({ devices }) =>
        devices.find(paired.device.id),
      );
      assert.ok(current);
      await database.transaction(ownerId, ({ devices }) =>
        devices.revoke(current.id, current.revision),
      );
      assert.equal(await supports(third), false);
      assert.equal(await advertise(third, ["command"]), false);
    } finally {
      await database.close();
    }
  });
});

test("proxy sessions fence reconnects and report only fresh explicit availability", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    async function register() {
      return database.transaction(ownerId, async ({ devices }) => {
        const challenge = await devices.start("Session fixture");
        const paired = await devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["command"],
        });
        assert.ok(paired);
        return paired;
      });
    }
    const identity = (value: DeviceSessionIdentity) => ({
      deviceId: value.deviceId,
      sessionId: value.sessionId,
      generation: value.generation,
    });
    try {
      for (const id of [ownerId, other])
        await database.transaction(id, ({ owners }) => owners.ensure());
      const first = await register();
      const second = await register();
      assert.equal(
        await database.transaction(other, ({ deviceSessions }) =>
          deviceSessions.open(first.device.id, first.credential),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.open(first.device.id, second.credential),
        ),
        null,
      );
      const opened = await database.transaction(ownerId, ({ deviceSessions }) =>
        deviceSessions.open(first.device.id, first.credential),
      );
      assert.ok(opened);
      assert.deepEqual(await database.deviceSessionOwners(), [ownerId]);
      assert.deepEqual(await database.deviceSessionOwners(ownerId), []);
      const old = identity(opened);
      assert.equal(opened.generation, 1);
      assert.ok(Date.parse(opened.expiresAt) > Date.now());
      assert.ok(
        (
          await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.presence())
        ).every((item) => item.status === "unreachable" && item.lastSeenAt === null),
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(old, "ready"),
        ),
        true,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(old, "ready"),
        ),
        true,
      );
      const online = (
        await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.presence())
      ).find((item) => item.deviceId === first.device.id);
      assert.equal(online?.status, "ready");
      assert.ok(online.lastSeenAt);
      const events = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'device.presence-changed'`;
      assert.equal(events[0]?.count, 1);
      const replacements = await Promise.all(
        [0, 1].map(() =>
          database.transaction(ownerId, ({ deviceSessions }) =>
            deviceSessions.open(first.device.id, first.credential),
          ),
        ),
      );
      const newest = replacements.find((value) => value?.generation === 3);
      const older = replacements.find((value) => value?.generation === 2);
      assert.ok(newest && older);
      const current = identity(newest);
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(old, "sleeping"),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.close(identity(older)),
        ),
        false,
      );
      assert.equal(
        await database.transaction(other, ({ deviceSessions }) =>
          deviceSessions.heartbeat(current, "ready"),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(current, "locked"),
        ),
        true,
      );
      const secondOpen = await database.transaction(ownerId, ({ deviceSessions }) =>
        deviceSessions.open(second.device.id, second.credential),
      );
      assert.ok(secondOpen);
      const secondSession = identity(secondOpen);
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(secondSession, "paused"),
        ),
        true,
      );
      await sql`UPDATE winston.device_sessions SET lease_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND device_id = ${first.device.id}::uuid`;
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(current, "ready"),
        ),
        false,
      );
      const presence = await database.transaction(ownerId, ({ deviceSessions }) =>
        deviceSessions.presence(),
      );
      assert.equal(
        presence.find((item) => item.deviceId === first.device.id)?.status,
        "unreachable",
      );
      assert.equal(presence.find((item) => item.deviceId === second.device.id)?.status, "paused");
      const expired = await Promise.all(
        [0, 1].map(() =>
          database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.expire()),
        ),
      );
      assert.deepEqual(expired.sort(), [0, 1]);
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.expire()),
        0,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.close(current)),
        false,
      );
      await sql`UPDATE winston.devices SET token_hash = ${"0".repeat(64)} WHERE owner_id = ${ownerId}::uuid AND id = ${second.device.id}::uuid`;
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(secondSession, "ready"),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.open(second.device.id, second.credential),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.expire()),
        1,
      );
      assert.deepEqual(await database.deviceSessionOwners(), []);
      assert.deepEqual(
        await database.transaction(other, ({ deviceSessions }) => deviceSessions.presence()),
        [],
      );
      const reopened = await database.transaction(ownerId, ({ deviceSessions }) =>
        deviceSessions.open(first.device.id, first.credential),
      );
      assert.ok(reopened);
      assert.equal(reopened.generation, 4);
      await database.transaction(ownerId, ({ devices }) =>
        devices.revoke(first.device.id, first.device.revision),
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.heartbeat(identity(reopened), "ready"),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) =>
          deviceSessions.open(first.device.id, first.credential),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ deviceSessions }) => deviceSessions.expire()),
        1,
      );
      const offline = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston.events WHERE owner_id = ${ownerId}::uuid AND type = 'device.offline'`;
      assert.equal(offline[0]?.count, 3);
    } finally {
      await database.close();
    }
  });
});
