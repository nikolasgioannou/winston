import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
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

test("Gmail label CLI preserves approvals and reconciles uncertainty through authorized reads", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const botId = 12345;
    const userId = 123;
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.gmail],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 10).toString("base64") }),
    );
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    const labels = [
      { id: "custom1", name: "Projects\u202e", type: "user" },
      { id: "INBOX", name: "INBOX", type: "system" },
    ];
    let reads = 0;
    let writes = 0;
    let lost = false;
    const mutations = createGmailLabelMutationGateway({
      database,
      google,
      fetch: (url, init) => {
        if (init.method === "GET") {
          reads++;
          if (url.pathname.endsWith("/labels")) return Promise.resolve(Response.json({ labels }));
          if (url.pathname.includes("/labels/"))
            return Promise.resolve(
              Response.json(labels.find((label) => url.pathname.endsWith(`/${label.id}`))),
            );
          assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1");
          return Promise.resolve(
            Response.json({
              id: "m1",
              threadId: "t1",
              labelIds: ["INBOX"],
              payload: { partId: "", mimeType: "text/plain", body: { size: 0 }, headers: [] },
            }),
          );
        }
        writes++;
        assert.equal(init.method, "POST");
        assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1/modify");
        if (lost) return Promise.reject(new Error("Lost reply"));
        return Promise.resolve(Response.json({ id: "m1", threadId: "t1", labelIds: ["custom1"] }));
      },
    });
    let observations = 0;
    let observedLabels: string[] | null = ["INBOX"];
    const reconciliation = createGmailReconciliationGateway({
      database,
      google,
      artifacts: () => Promise.resolve(null),
      fetch: (url, init) => {
        observations++;
        assert.equal(init.method, "GET");
        assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1");
        assert.equal(url.searchParams.get("format"), "minimal");
        return Promise.resolve(
          Response.json({ id: "m1", threadId: "t1", labelIds: observedLabels }),
        );
      },
    });
    const { app } = createApi({
      groups: {
        task: createCliTaskGroup(database, {
          gmailLabelMutations: mutations,
          gmailReconciliation: reconciliation,
        }),
      },
    });
    const task = () =>
      database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Synthetic labels",
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
    async function gateway(
      access: Awaited<ReturnType<typeof credential>>,
      key = "organize",
      readRoute = false,
    ) {
      const parsed = parseCommand([
        "gmail",
        "modify",
        "--account",
        accountId,
        "--id",
        "m1",
        "--key",
        key,
        "--add-labels",
        '["custom1"]',
        "--remove-labels",
        '["INBOX"]',
      ]);
      assert.equal(parsed.kind, "request");
      return callGateway(access, parsed.request, (url, init) =>
        Promise.resolve(app.request(readRoute ? "/api/tasks/cli" : new URL(url).pathname, init)),
      );
    }
    async function reconcile(
      access: Awaited<ReturnType<typeof credential>>,
      id: string,
      key: string,
    ) {
      const parsed = parseCommand(["gmail", "reconcile", "--id", id, "--key", key]);
      assert.equal(parsed.kind, "request");
      return callGateway(access, parsed.request, (url, init) =>
        Promise.resolve(app.request(new URL(url).pathname, init)),
      );
    }
    async function approve(
      result: CliResult,
      current: Awaited<ReturnType<typeof task>>,
      telegram = false,
    ) {
      assert.equal(result.status, "waiting");
      assert.ok(result.referenceId);
      const id = result.referenceId;
      const action = await database.transaction(ownerId, ({ actions }) => actions.find(id));
      assert.ok(action);
      if (telegram) {
        const card = await database.transaction(ownerId, ({ telegramApprovals }) =>
          telegramApprovals.prepare(id, botId),
        );
        assert.ok(card);
        const delivery = await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.claim(botId),
        );
        assert.ok(delivery);
        assert.match(delivery.text, /Change Gmail message labels/);
        assert.match(delivery.text, /owner@example.com/);
        assert.match(delivery.text, /custom1/);
        assert.match(delivery.text, /\\u202e/);
        assert.ok(!delivery.text.includes("\u202e"));
        const token = delivery.keyboard?.inline_keyboard[0]?.[0]?.callback_data;
        assert.ok(token);
        await database.transaction(ownerId, ({ telegramOutbound }) =>
          telegramOutbound.settle(delivery, { state: "sent", messageId: 100 }),
        );
        assert.deepEqual(
          await database.transaction(ownerId, ({ telegramApprovals }) =>
            telegramApprovals.decide({ botId, userId, chatId: userId, token, messageId: 100 }),
          ),
          { state: "approved", duplicate: false },
        );
      } else {
        await database.transaction(ownerId, ({ actions }) =>
          actions.decide({ id, revision: action.revision, hash: action.hash, approve: true }),
        );
      }
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
      await sql`INSERT INTO winston.telegram_bindings (owner_id,bot_id,user_id,chat_id) VALUES (${ownerId}::uuid,${botId},${userId},${userId})`;
      let current = await task();
      let access = await credential(current);
      assert.notEqual((await gateway(access, "organize", true)).status, "ok");
      let result = await gateway(access);
      assert.equal(reads, 0);
      current = await approve(result, current);
      access = await credential(current);
      result = await gateway(access);
      assert.equal(reads, 1);
      current = await approve(result, current);
      access = await credential(current);
      result = await gateway(access);
      assert.equal(reads, 2);
      assert.equal(writes, 0);
      current = await approve(result, current, true);
      access = await credential(current);
      assert.equal((await gateway(access)).status, "ok");
      assert.equal(reads, 5, "Source inspections are not repeated after write approval");
      assert.equal(writes, 1);
      assert.equal((await gateway(access)).status, "ok");
      assert.equal(writes, 1);

      current = await task();
      access = await credential(current);
      lost = true;
      result = await gateway(access);
      while (result.status === "waiting") {
        current = await approve(result, current);
        access = await credential(current);
        result = await gateway(access);
      }
      assert.equal(result.status, "unknown");
      assert.ok(result.referenceId);
      const id = result.referenceId;
      const readsBeforeFence = reads;
      assert.equal((await gateway(access, "replacement")).status, "unknown");
      assert.equal(reads, readsBeforeFence);
      current = await approve(await reconcile(access, id, "observe"), current);
      access = await credential(current);
      assert.equal((await reconcile(access, id, "observe")).status, "unknown");
      assert.equal(observations, 1);
      for (const labels of [["custom1", "TRASH"], ["custom1", "INBOX"], null]) {
        observedLabels = labels;
        const observationKey = JSON.stringify(labels);
        current = await approve(await reconcile(access, id, observationKey), current);
        access = await credential(current);
        assert.equal((await reconcile(access, id, observationKey)).status, "unknown");
        assert.equal(
          (await database.transaction(ownerId, ({ actions }) => actions.find(id)))?.state,
          "unknown",
        );
      }
      observedLabels = ["custom1"];
      assert.equal((await reconcile(access, id, "observe")).status, "unknown");
      assert.equal(observations, 4);
      current = await approve(await reconcile(access, id, "refresh"), current);
      access = await credential(current);
      const resolved = await reconcile(access, id, "refresh");
      assert.equal(resolved.status, "ok");
      assert.match(JSON.stringify(resolved), /does not establish who/);
      assert.equal(observations, 5);
      assert.equal(writes, 2, "No reconciliation sends a write");
      assert.equal((await gateway(access, "after-resolution")).status, "waiting");

      // Even matching evidence cannot bypass revoked read access.
      current = await task();
      access = await credential(current);
      result = await gateway(access);
      while (result.status === "waiting") {
        current = await approve(result, current);
        access = await credential(current);
        result = await gateway(access);
      }
      assert.equal(result.status, "unknown");
      assert.ok(result.referenceId);
      const revokedId = result.referenceId;
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          target: { kind: "connection", id: accountId, resource: null },
          operation: "gmail.read",
          revision: 0,
          decision: "deny",
        }),
      );
      const previousObservations = observations;
      assert.equal((await reconcile(access, revokedId, "revoked")).status, "unknown");
      assert.equal(observations, previousObservations);
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(revokedId)))?.state,
        "unknown",
      );
    } finally {
      await database.close();
    }
  });
});
