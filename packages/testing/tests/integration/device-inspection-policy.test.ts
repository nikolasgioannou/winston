import assert from "node:assert/strict";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

test("file inspection requires an advertised capability and its own current permission", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = crypto.randomUUID();
    try {
      await database.transaction(ownerId, async (scope) => {
        await scope.owners.ensure();
        const challenge = await scope.devices.start("Inspection fixture");
        const paired = await scope.devices.pair(challenge.secret, {
          platform: "macos",
          appVersion: "0.1.0",
          protocolVersion: 1,
          capabilities: ["file.read"],
        });
        assert.ok(paired);
        const target = { kind: "device" as const, id: paired.device.id, resource: null };
        const metadata = { target, operation: "device.file.metadata" as const };
        const listing = { target, operation: "device.file.list" as const };
        assert.equal((await scope.authorization.evaluate(metadata)).decision, "deny");
        assert.equal((await scope.authorization.evaluate(listing)).decision, "deny");
        const opened = await scope.deviceSessions.open(paired.device.id, paired.credential);
        assert.ok(opened);
        const session = {
          deviceId: opened.deviceId,
          sessionId: opened.sessionId,
          generation: opened.generation,
        };
        await scope.deviceSessions.advertise(session, ["file.read", "file.metadata", "file.list"]);
        const policy = await scope.authorization.list();
        const read = await scope.authorization.put({
          target,
          operation: "device.file.read",
          decision: "allow",
          revision: policy.revision,
        });
        assert.ok(read);
        assert.equal((await scope.authorization.evaluate(metadata)).decision, "ask");
        assert.equal((await scope.authorization.evaluate(listing)).decision, "ask");
        assert.ok(
          await scope.authorization.put({
            ...metadata,
            decision: "allow",
            revision: read.revision,
          }),
        );
        const allowed = await scope.authorization.evaluate(metadata);
        assert.equal(allowed.decision, "allow");
        assert.equal(allowed.broadAuthority, false);
        assert.equal((await scope.authorization.evaluate(listing)).decision, "ask");
        await scope.deviceSessions.advertise(session, ["file.read"]);
        assert.equal((await scope.authorization.evaluate(metadata)).decision, "deny");
      });
    } finally {
      await database.close();
    }
  });
});
