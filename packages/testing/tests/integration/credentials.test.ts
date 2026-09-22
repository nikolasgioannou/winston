import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { withTestPostgres } from "../../src/postgres";

test("encrypted grants rotate and revoke while service credentials enforce task, owner, action and lease scope", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const id = randomUUID();
    const firstKey = Buffer.alloc(32, 1).toString("base64");
    const secondKey = Buffer.alloc(32, 2).toString("base64");
    const vault = createCredentialVault(
      database,
      createCredentialCipher("first", { first: firstKey }),
    );
    const rotated = createCredentialVault(
      database,
      createCredentialCipher("second", { first: firstKey, second: secondKey }),
    );
    const grant = {
      accessToken: "synthetic-access-canary",
      refreshToken: "synthetic-refresh-canary",
      expiresAt: new Date().toISOString(),
      scopes: ["fixture"],
    };
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(otherOwner, ({ owners }) => owners.ensure());
      assert.equal(await vault.put(ownerId, id, grant, null), 0);
      const stored = await sql<{ encrypted: unknown }[]>`SELECT encrypted FROM winston.credentials`;
      assert.ok(!JSON.stringify(stored).includes("canary"));
      assert.deepEqual((await vault.read(ownerId, id))?.grant, grant);
      assert.equal(await vault.read(otherOwner, id), undefined);
      assert.equal(await rotated.rotate(ownerId, id), 1);
      assert.equal(await rotated.rotate(ownerId, id), 1);
      await assert.rejects(vault.put(ownerId, id, grant, 0), /revision changed/);
      assert.deepEqual((await rotated.read(ownerId, id))?.grant, grant);

      const task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: "credential-test",
          objective: "Fixture task",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const scope = {
        kind: "workspace" as const,
        subjectId: randomUUID(),
        taskId: task.id,
        revision: task.revision,
        generation: task.generation,
        operation: "connector:read" as const,
        resourceId: randomUUID(),
        credential: { id, revision: 1 },
      };
      const issue = () =>
        database.transaction(ownerId, ({ capabilities }) => capabilities.issue(scope));
      const first = await issue();
      const request = {
        token: first.token,
        kind: scope.kind,
        subjectId: scope.subjectId,
        operation: scope.operation,
        resourceId: scope.resourceId,
      };
      assert.ok(await database.authenticateService(request));
      assert.equal(await database.authenticateService({ ...request, kind: "worker" }), null);
      assert.equal(
        await database.authenticateService({ ...request, operation: "connector:write" }),
        null,
      );
      assert.equal(
        await database.authenticateService({ ...request, subjectId: randomUUID() }),
        null,
      );
      assert.equal(
        await database.authenticateService({ ...request, resourceId: randomUUID() }),
        null,
      );
      assert.equal(
        await database.transaction(otherOwner, ({ capabilities }) =>
          capabilities.authenticate(request),
        ),
        null,
      );
      const tokens = await sql<
        { token_hash: string; document: unknown }[]
      >`SELECT token_hash, document FROM winston.service_capabilities`;
      assert.ok(!JSON.stringify(tokens).includes(first.token));
      await database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(first.id));
      assert.equal(await database.authenticateService(request), null);

      const expired = await issue();
      await sql`UPDATE winston.service_capabilities SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${expired.id}::uuid`;
      assert.equal(await database.authenticateService({ ...request, token: expired.token }), null);
      const revokedGrant = await issue();
      await rotated.revoke(ownerId, id, 1);
      assert.equal(await rotated.read(ownerId, id), undefined);
      assert.equal(
        await database.authenticateService({ ...request, token: revokedGrant.token }),
        null,
      );
      await assert.rejects(issue(), /no longer current/);
      assert.equal(await rotated.put(ownerId, id, grant, 2), 3);
      scope.credential.revision = 3;
      const steered = await issue();
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.steer(task.id, task.revision, "Corrected fixture"),
      );
      assert.equal(await database.authenticateService({ ...request, token: steered.token }), null);
      const updated = await database.transaction(ownerId, ({ tasks }) => tasks.find(task.id));
      assert.ok(updated);
      const claimed = await database.transaction(ownerId, ({ tasks }) =>
        tasks.claim(updated.id, updated.revision),
      );
      scope.revision = claimed.revision;
      scope.generation = claimed.generation;
      const lease = await issue();
      await sql`UPDATE winston.tasks SET leased_until = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${task.id}::uuid`;
      assert.equal(await database.authenticateService({ ...request, token: lease.token }), null);
    } finally {
      await database.close();
    }
  });
});
