import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import type { CliRequest } from "@winston/contracts/cli";
import type { Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";
import { parseCommand } from "../../../../apps/cli/src/parse";

test("account discovery resolves explicit aliases without crossing identities or granting access", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 11).toString("base64") }),
    );
    const ownerId = randomUUID();
    const otherId = randomUUID();
    const workspaceId = randomUUID();
    const gmailId = randomUUID();
    const calendarId = randomUUID();
    const secondId = randomUUID();
    const foreignId = randomUUID();
    try {
      for (const id of [ownerId, otherId])
        await database.transaction(id, ({ owners }) => owners.ensure());
      for (const [id, owner, service, status] of [
        [gmailId, ownerId, "gmail", "connected"],
        [calendarId, ownerId, "calendar", "reconnect"],
        [secondId, ownerId, "gmail", "disconnected"],
        [foreignId, otherId, "gmail", "connected"],
      ] as const) {
        const connection: Connection = {
          id,
          subject: id,
          service,
          email: "owner@example.com",
          scopes: [],
          status,
          revision: 0,
          calendars: service === "calendar" ? ["primary"] : [],
        };
        await vault.put(
          owner,
          id,
          {
            accessToken: "synthetic",
            refreshToken: "synthetic",
            expiresAt: "2030-01-01T00:00:00.000Z",
            scopes: [],
          },
          null,
        );
        await sql`INSERT INTO winston.google_connections (owner_id,id,subject,service,document) VALUES (${owner}::uuid,${id}::uuid,${id},${service},${JSON.stringify(connection)}::text::jsonb)`;
      }
      await database.transaction(ownerId, async ({ connectionTargets }) => {
        assert.ok(
          await connectionTargets.put({
            revision: 0,
            defaults: [],
            labels: [
              { target: { connectionId: gmailId, calendarId: null }, label: "Work" },
              { target: { connectionId: secondId, calendarId: null }, label: "Old" },
            ],
          }),
        );
      });
      const task = await database.transaction(ownerId, async ({ tasks, workspaces }) => {
        await workspaces.register(workspaceId, "Accounts fixture");
        await workspaces.setState(workspaceId, 0, "active");
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Inspect accounts",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const grant = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          operation: "gateway:read",
          credential: null,
        }),
      );
      const credential = {
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:read" as const,
        token: grant.token,
      };
      const run = (request: CliRequest) =>
        database.transaction(ownerId, ({ cli }) => cli.execute(credential, request));
      const inspect = (id: string) => run({ version: 1, command: "accounts.inspect", id });
      const resolve = (alias: string, service: "gmail" | "calendar" = "gmail") => {
        const command = parseCommand([
          "accounts",
          "resolve",
          "--service",
          service,
          "--alias",
          alias,
        ]);
        assert.equal(command.kind, "request");
        return run(command.request);
      };
      const found = await resolve("work");
      assert.equal(found.status, "ok");
      assert.deepEqual(found.data, {
        id: gmailId,
        service: "gmail",
        email: "owner@example.com",
        status: "connected",
        revision: 0,
        label: "Work",
        preferencesRevision: 1,
      });
      assert.equal((await resolve("owner@example.com")).status, "unavailable");
      assert.equal((await resolve("unknown")).status, "unavailable");
      assert.equal((await inspect(foreignId)).status, "denied");
      const calendar = await resolve("OWNER@example.com", "calendar");
      assert.equal(calendar.status, "ok");
      assert.match(JSON.stringify(calendar.data), /reconnect/);
      assert.match(JSON.stringify(await inspect(secondId)), /disconnected/);
      await database.transaction(ownerId, async ({ connectionTargets }) => {
        const current = await connectionTargets.preferences();
        assert.ok(
          await connectionTargets.put({
            ...current,
            labels: current.labels.map((entry) =>
              entry.target.connectionId === gmailId ? { ...entry, label: "Business" } : entry,
            ),
          }),
        );
      });
      assert.equal((await resolve("Work")).status, "unavailable");
      assert.equal((await resolve("Business")).status, "ok");
      await database.transaction(ownerId, async ({ connectionTargets }) => {
        const current = await connectionTargets.preferences();
        assert.ok(
          await connectionTargets.put({
            ...current,
            labels: current.labels.map((entry) => ({ ...entry, label: "Business" })),
          }),
        );
      });
      assert.equal((await resolve("Business")).status, "unavailable");
      await database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(grant.id));
      assert.equal((await inspect(gmailId)).status, "denied");
      assert.equal((await resolve("Business")).status, "denied");
    } finally {
      await database.close();
    }
  });
});
