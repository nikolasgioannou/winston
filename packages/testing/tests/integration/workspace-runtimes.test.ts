import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { workspaceOriginSchema } from "@winston/contracts/workspace-runtime";
import { withTestPostgres } from "../../src/postgres";

test("runtime destinations are private origins without redirects, credentials or paths", () => {
  for (const origin of ["http://fixture.flycast", "http://127.0.0.1:8080", "http://[::1]:8080/"])
    assert.equal(workspaceOriginSchema.parse(origin), new URL(origin).origin);
  for (const origin of [
    "https://external.example",
    "http://169.254.169.254",
    "http://fixture.flycast.evil",
    "http://fixture.flycast/path",
    "http://user:secret@fixture.flycast",
    "http://fixture.flycast/?next=x",
    "http://fixture.flycast/#x",
    "http://fixture.flycast:3000",
  ])
    assert.equal(workspaceOriginSchema.safeParse(origin).success, false);
});

test("trusted runtime registration isolates owners and invalidates previous workspace authority", async () => {
  await withTestPostgres(async (_sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const other = randomUUID();
    const id = randomUUID();
    const second = randomUUID();
    try {
      for (const owner of [ownerId, other])
        await database.transaction(owner, ({ owners }) => owners.ensure());
      await database.transaction(ownerId, ({ workspaces }) => workspaces.register(id, "First"));
      await database.transaction(other, ({ workspaces }) => workspaces.register(second, "Second"));
      const configure = (
        revision: number,
        origin = "http://fixture.flycast",
        owner = ownerId,
        workspaceId = id,
      ) =>
        database.transaction(owner, ({ workspaceRuntimes }) =>
          workspaceRuntimes.configure({ workspaceId, revision, origin }),
        );
      const resolve = (owner = ownerId) =>
        database.transaction(owner, ({ workspaceRuntimes }) => workspaceRuntimes.resolve(id));
      assert.equal(await resolve(), null);
      assert.deepEqual(await configure(0), {
        workspaceId: id,
        revision: 1,
        origin: "http://fixture.flycast",
      });
      assert.deepEqual(await configure(1, "http://fixture.flycast/"), {
        workspaceId: id,
        revision: 1,
        origin: "http://fixture.flycast",
      });
      assert.equal(await resolve(), null);
      await assert.rejects(configure(0), /changed/);
      await assert.rejects(configure(1, "http://other.flycast", other), /unavailable/);
      await assert.rejects(configure(0, "http://fixture.flycast", other, second));
      await database.transaction(ownerId, ({ workspaces }) => workspaces.setState(id, 1, "active"));
      assert.equal((await resolve())?.revision, 2);
      assert.equal(await resolve(other), null);
      const task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Runtime routing fixture",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const grant = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: id,
          resourceId: id,
          resourceRevision: 2,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          operation: "gateway:read",
          credential: null,
        }),
      );
      const credential = {
        token: grant.token,
        kind: "workspace" as const,
        subjectId: id,
        resourceId: id,
        operation: "gateway:read" as const,
      };
      assert.ok(await database.authenticateService(credential));
      await configure(2, "http://replacement.flycast");
      assert.equal(await database.authenticateService(credential), null);
      assert.deepEqual(await resolve(), {
        workspaceId: id,
        revision: 3,
        origin: "http://replacement.flycast",
      });
      await database.transaction(ownerId, ({ workspaces }) => workspaces.setState(id, 3, "paused"));
      assert.equal(await resolve(), null);
      await database.transaction(ownerId, ({ workspaces }) =>
        workspaces.setState(id, 4, "retired"),
      );
      assert.equal(await resolve(), null);
      await assert.rejects(configure(5), /unavailable/);
    } finally {
      await database.close();
    }
  });
});
