import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  createGmailTrashGateway,
  createGmailLabelMutationGateway,
  createGmailReconciliationGateway,
} from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { CliResult } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";
import { parseCommand } from "../../../../apps/cli/src/parse";
import { callGateway } from "../../../../apps/cli/src/gateway";
import { createApi } from "../../../../apps/server/src/http/app";
import { createCliTaskGroup } from "../../../../apps/server/src/http/cli";

test("Gmail trash and restore use separate authority, exact endpoints and read reconciliation", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.gmail],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 11).toString("base64") }),
    );
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    let state: string[] = ["INBOX"];
    let reads = 0;
    let writes = 0;
    let lost = false;
    let revokeDuringGuard = false;
    const provider = async (url: URL, init: RequestInit) => {
      assert.equal(url.origin, "https://gmail.googleapis.com");
      if (init.method === "GET") {
        reads++;
        assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1");
        if (url.searchParams.get("format") === "minimal" && revokeDuringGuard) {
          await database.transaction(ownerId, async ({ authorization }) => {
            const current = await authorization.list();
            assert.ok(
              await authorization.put({
                target: { kind: "connection", id: accountId, resource: null },
                operation: "gmail.trash",
                revision: current.revision,
                decision: "deny",
              }),
            );
          });
        }
        return Response.json({
          id: "m1",
          threadId: "t1",
          labelIds: state,
          payload: { partId: "", mimeType: "text/plain", body: { size: 0 }, headers: [] },
        });
      }
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined, "Trash endpoints have an empty body");
      assert.ok(
        ["/gmail/v1/users/me/messages/m1/trash", "/gmail/v1/users/me/messages/m1/untrash"].includes(
          url.pathname,
        ),
      );
      writes++;
      state = url.pathname.endsWith("/untrash") ? [] : ["TRASH"];
      if (lost) throw new Error("Lost reply");
      return Response.json({ id: "m1", threadId: "t1", labelIds: state });
    };
    const options = { database, google, fetch: provider };
    const { app } = createApi({
      groups: {
        task: createCliTaskGroup(database, {
          gmailTrash: createGmailTrashGateway(options),
          gmailLabelMutations: createGmailLabelMutationGateway(options),
          gmailReconciliation: createGmailReconciliationGateway({
            ...options,
            artifacts: () => Promise.resolve(null),
          }),
        }),
      },
    });
    const task = () =>
      database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Synthetic trash",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    async function credential(current: Awaited<ReturnType<typeof task>>) {
      const issued = await database.transaction(ownerId, ({ capabilities }) =>
        capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: current.id,
          revision: current.revision,
          generation: current.generation,
          operation: "gateway:control",
          credential: null,
        }),
      );
      return {
        version: 1 as const,
        environment: "local" as const,
        workspaceId,
        token: `wst_${"r".repeat(43)}`,
        controlToken: issued.token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    }
    async function cli(
      access: Awaited<ReturnType<typeof credential>>,
      args: string[],
      readRoute = false,
    ) {
      const parsed = parseCommand(args);
      assert.equal(parsed.kind, "request");
      return callGateway(access, parsed.request, (url, init) =>
        Promise.resolve(app.request(readRoute ? "/api/tasks/cli" : new URL(url).pathname, init)),
      );
    }
    const command = (kind: "trash" | "restore", key: string = kind) => [
      "gmail",
      kind,
      "--account",
      accountId,
      "--id",
      "m1",
      "--key",
      key,
    ];
    async function approve(result: CliResult, current: Awaited<ReturnType<typeof task>>) {
      assert.equal(result.status, "waiting");
      assert.ok(result.referenceId);
      const id = result.referenceId;
      const action = await database.transaction(ownerId, ({ actions }) => actions.find(id));
      assert.ok(action);
      assert.equal(action.request.authorization.operation, "gmail.trash");
      const card = await database.transaction(ownerId, ({ telegramApprovals }) =>
        telegramApprovals.prepare(id, 12345),
      );
      assert.ok(card);
      const delivery = await database.transaction(ownerId, ({ telegramOutbound }) =>
        telegramOutbound.claim(12345),
      );
      assert.ok(delivery);
      assert.match(delivery.text, /Gmail message/);
      assert.match(delivery.text, /owner@example.com/);
      assert.match(delivery.text, /Message: "m1"/);
      await database.transaction(ownerId, ({ telegramOutbound }) =>
        telegramOutbound.settle(delivery, { state: "sent", messageId: 100 + writes }),
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({ id, revision: action.revision, hash: action.hash, approve: true }),
      );
      return database.transaction(ownerId, async ({ tasks }) => {
        const waiting = await tasks.find(current.id);
        assert.ok(waiting);
        const queued = await tasks.resume(waiting.id, waiting.revision, id);
        return tasks.claim(queued.id, queued.revision);
      });
    }
    try {
      await database.transaction(ownerId, async ({ owners, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Fixture");
        await workspaces.setState(workspaceId, 0, "active");
      });
      await vault.put(ownerId, accountId, grant, null);
      const connection: Connection = {
        id: accountId,
        subject: accountId,
        service: "gmail",
        email: "owner@example.com",
        scopes: grant.scopes,
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await sql`INSERT INTO winston.google_connections (owner_id,id,subject,service,document) VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'gmail',${JSON.stringify(connection)}::text::jsonb)`;
      await sql`INSERT INTO winston.telegram_bindings (owner_id,bot_id,user_id,chat_id) VALUES (${ownerId}::uuid,12345,123,123)`;
      for (const operation of ["gmail.read", "gmail.modify"] as const)
        await database.transaction(ownerId, async ({ authorization }) => {
          const current = await authorization.list();
          assert.ok(
            await authorization.put({
              target: { kind: "connection", id: accountId, resource: null },
              operation,
              revision: current.revision,
              decision: "allow",
            }),
          );
        });
      let current = await task();
      let access = await credential(current);
      assert.notEqual((await cli(access, command("trash"), true)).status, "ok");
      const waiting = await cli(access, command("trash"));
      assert.equal(waiting.status, "waiting", "Label allow is not trash authority");
      assert.equal(writes, 0);
      current = await approve(waiting, current);
      access = await credential(current);
      assert.equal((await cli(access, command("trash"))).status, "ok");
      assert.equal(writes, 1);
      assert.deepEqual(state, ["TRASH"]);
      assert.equal((await cli(access, command("trash"))).status, "ok");
      assert.equal(writes, 1);
      current = await task();
      access = await credential(current);
      current = await approve(await cli(access, command("restore")), current);
      access = await credential(current);
      assert.equal((await cli(access, command("restore"))).status, "ok");
      assert.deepEqual(state, []);
      assert.equal(writes, 2);
      for (const kind of ["trash", "restore"] as const) {
        current = await task();
        access = await credential(current);
        current = await approve(await cli(access, command(kind)), current);
        access = await credential(current);
        lost = true;
        const unknown = await cli(access, command(kind));
        assert.equal(unknown.status, "unknown");
        assert.ok(unknown.referenceId);
        const priorWrites: number = writes;
        const priorReads = reads;
        assert.equal((await cli(access, command(kind, "new-key"))).status, "unknown");
        assert.equal(
          (
            await cli(access, [
              "gmail",
              "modify",
              "--account",
              accountId,
              "--id",
              "m1",
              "--key",
              "label-bypass",
              "--add-labels",
              '["STARRED"]',
            ])
          ).status,
          "unknown",
        );
        assert.equal(reads, priorReads);
        const resolved = await cli(access, [
          "gmail",
          "reconcile",
          "--id",
          unknown.referenceId,
          "--key",
          "observe",
        ]);
        assert.equal(resolved.status, "ok");
        assert.equal(writes, priorWrites);
      }
      lost = false;
      current = await task();
      access = await credential(current);
      state = ["DRAFT"];
      const beforeDraft = writes;
      assert.equal((await cli(access, command("trash"))).status, "unavailable");
      assert.equal(writes, beforeDraft);
      for (const changedState of [["DRAFT"], ["TRASH"]]) {
        state = ["INBOX"];
        current = await task();
        access = await credential(current);
        current = await approve(await cli(access, command("trash")), current);
        access = await credential(current);
        state = changedState;
        assert.equal((await cli(access, command("trash"))).status, "unavailable");
        assert.equal(writes, beforeDraft, "Changed state after approval prevents the write");
      }
      state = ["INBOX"];
      current = await task();
      access = await credential(current);
      current = await approve(await cli(access, command("trash")), current);
      access = await credential(current);
      revokeDuringGuard = true;
      assert.equal((await cli(access, command("trash"))).status, "unavailable");
      assert.equal(writes, beforeDraft);
    } finally {
      await database.close();
    }
  });
});
