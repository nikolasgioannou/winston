import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createGoogleConnections, GoogleAccessError } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("Google refresh serializes across instances and disconnect fences in-flight refresh", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const cipher = createCredentialCipher("fixture", {
      fixture: Buffer.alloc(32, 9).toString("base64"),
    });
    const vault = createCredentialVault(database, cipher);
    const ownerId = randomUUID();
    let subject = "first";
    let calls = 0;
    let failure: "reconnect" | "unavailable" | undefined;
    let started = Promise.withResolvers<undefined>();
    let release = Promise.withResolvers<undefined>();
    const options = {
      database,
      cipher,
      oauth: {
        url: (_service: string, state: string) => `https://accounts.google.com/?state=${state}`,
        exchange: () =>
          Promise.resolve({
            subject,
            email: `${subject}@example.com`,
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: new Date(0).toISOString(),
            scopes: [...googleScopes.gmail],
          }),
        refresh: async () => {
          calls += 1;
          started.resolve(undefined);
          await release.promise;
          if (failure) throw new GoogleAccessError(failure);
          return {
            accessToken: "new-access",
            refreshToken: "rotated-refresh",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            scopes: [...googleScopes.gmail],
          };
        },
      },
    };
    const a = createGoogleConnections(options);
    const b = createGoogleConnections(options);
    const signal = new AbortController().signal;
    async function connect() {
      const { url } = await a.start(ownerId, "session", { service: "gmail" });
      const state = new URL(url).searchParams.get("state");
      assert.ok(state);
      return a.finish(ownerId, "session", state, "code", signal);
    }
    async function expire(connection: Connection) {
      const current = await vault.read(ownerId, connection.id);
      assert.ok(current);
      await vault.put(
        ownerId,
        connection.id,
        {
          ...current.grant,
          expiresAt: new Date(0).toISOString(),
        },
        current.revision,
      );
    }
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const first = await connect();
      const one = a.access(ownerId, first.id, signal);
      await started.promise;
      const two = b.access(ownerId, first.id, signal);
      release.resolve(undefined);
      const results = await Promise.all([one, two]);
      assert.equal(calls, 1);
      assert.equal(results[0].grant.refreshToken, "rotated-refresh");
      assert.equal(results[1].revision, results[0].revision);

      subject = "second";
      const second = await connect();
      await a.access(ownerId, second.id, signal);
      await expire(first);
      started = Promise.withResolvers<undefined>();
      release = Promise.withResolvers<undefined>();
      const racing = a.access(ownerId, first.id, signal);
      const rejected = assert.rejects(racing, GoogleAccessError);
      await started.promise;
      await b.disconnect(ownerId, first.id, first.revision);
      release.resolve(undefined);
      await rejected;
      assert.equal(await vault.read(ownerId, first.id), undefined);
      assert.equal((await b.access(ownerId, second.id, signal)).grant.accessToken, "new-access");
      await assert.rejects(a.access(ownerId, first.id, signal), /disconnected/);

      await expire(second);
      failure = "unavailable";
      await assert.rejects(a.access(ownerId, second.id, signal), /unavailable/);
      assert.equal(
        (await a.list(ownerId)).find((item) => item.id === second.id)?.status,
        "connected",
      );
      failure = "reconnect";
      await assert.rejects(a.access(ownerId, second.id, signal), /reconnect/);
      assert.equal(
        (await a.list(ownerId)).find((item) => item.id === second.id)?.status,
        "reconnect",
      );
      assert.equal(await vault.read(ownerId, second.id), undefined);
      await assert.rejects(a.access(ownerId, second.id, signal), /reconnect/);
    } finally {
      release.resolve(undefined);
      await database.close();
    }
  });
});
