import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { z } from "zod";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  createGmailMutationGateway,
  createGmailReconciliationGateway,
} from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { GmailMutationInput } from "@winston/contracts/gmail-mutations";
import type { CliResult } from "@winston/contracts/cli";
import { withTestPostgres } from "../../src/postgres";
import { parseCommand } from "../../../../apps/cli/src/parse";
import { callGateway } from "../../../../apps/cli/src/gateway";
import { createApi } from "../../../../apps/server/src/http/app";
import { createCliTaskGroup } from "../../../../apps/server/src/http/cli";

test("Gmail CLI approvals preserve exact content across source reads, Telegram review and resume", async () => {
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
      createCredentialCipher("test", {
        test: Buffer.alloc(32, 9).toString("base64"),
      }),
    );
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    const message = {
      from: { email: "owner@example.com" },
      to: [{ email: "guest@example.com" }],
      cc: [],
      bcc: [{ email: "private@example.com" }],
      subject: "Review",
      text: "Exact content. ".repeat(700),
      html: null,
      reply: null,
      attachments: [],
    };
    const send: GmailMutationInput = {
      key: "send",
      intent: { kind: "message.send", accountId, message },
    };
    let reads = 0;
    let writes = 0;
    let loseReply = false;
    let savedRaw = "";
    let hold: Promise<undefined> | undefined;
    const started = Promise.withResolvers<undefined>();
    const mutation = createGmailMutationGateway({
      database,
      google,
      artifacts: () => Promise.resolve(null),
      fetch: (url, init) => {
        if (init.method === "GET") {
          reads++;
          if (url.pathname.endsWith("/messages/source1")) {
            return Promise.resolve(
              Response.json({
                id: "source1",
                threadId: "thread1",
                payload: {
                  partId: "",
                  mimeType: "text/plain",
                  body: { size: 0 },
                  headers: [
                    { name: "Subject", value: "=?UTF-8?B?UmV2aWV3?=" },
                    { name: "Message-ID", value: "<source@example.com>" },
                  ],
                },
              }),
            );
          }
          assert.equal(url.pathname.endsWith("/drafts/draft1"), true);
          return Promise.resolve(
            Response.json({
              id: "draft1",
              message: {
                id: "message1",
                threadId: "thread1",
                payload: {
                  partId: "",
                  mimeType: "text/plain",
                  headers: [{ name: "Subject", value: "Review" }],
                  body: { size: 4, data: Buffer.from("Body").toString("base64url") },
                },
              },
            }),
          );
        }
        writes++;
        assert.ok(typeof init.body === "string");
        assert.match(init.body, /raw/);
        const body = z
          .union([
            z.object({ raw: z.string() }),
            z.object({ message: z.object({ raw: z.string() }) }),
          ])
          .parse(JSON.parse(init.body));
        savedRaw = "raw" in body ? body.raw : body.message.raw;
        if (hold) {
          started.resolve(undefined);
          return hold.then(() => Promise.reject(new Error("Lost response after hold")));
        }
        if (loseReply) return Promise.reject(new Error("Lost provider reply"));
        return Promise.resolve(
          Response.json(
            url.pathname.endsWith("/messages/send")
              ? { id: "sent1", threadId: "thread1" }
              : { id: "draft1", message: { id: "message2", threadId: "thread1" } },
          ),
        );
      },
    });
    let observations = 0;
    let evidenceMode = "missing";
    const reconcileGateway = createGmailReconciliationGateway({
      database,
      google,
      artifacts: () => Promise.resolve(null),
      fetch: (url, init) => {
        observations++;
        assert.equal(init.method, "GET");
        if (url.pathname.endsWith("/messages") || url.pathname.endsWith("/drafts")) {
          assert.match(url.searchParams.get("q") ?? "", /^rfc822msgid:</);
          assert.equal(url.searchParams.get("maxResults"), "2");
          const item = url.pathname.endsWith("/drafts")
            ? { id: "draft1", message: { id: "sent1", threadId: "thread1" } }
            : { id: "sent1", threadId: "thread1" };
          return Promise.resolve(
            Response.json({
              [url.pathname.endsWith("/drafts") ? "drafts" : "messages"]:
                evidenceMode === "missing"
                  ? []
                  : evidenceMode === "duplicate"
                    ? [item, item]
                    : [item],
            }),
          );
        }
        assert.equal(url.searchParams.get("format"), "raw");
        const raw =
          evidenceMode === "bcc"
            ? Buffer.from(savedRaw, "base64url")
                .toString("utf8")
                .replace("private@example.com", "other@example.com")
            : Buffer.from(savedRaw, "base64url").toString("utf8");
        const found = {
          id: "sent1",
          threadId: "thread1",
          raw: evidenceMode === "malformed" ? "!" : Buffer.from(raw).toString("base64url"),
          labelIds: ["SENT"],
        };
        return Promise.resolve(
          Response.json(
            url.pathname.includes("/drafts/") ? { id: "draft1", message: found } : found,
          ),
        );
      },
    });
    const { app } = createApi({
      groups: {
        task: createCliTaskGroup(database, {
          gmailMutations: mutation,
          gmailReconciliation: reconcileGateway,
        }),
      },
    });
    async function task() {
      return database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Synthetic Gmail",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    }
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
    async function gateway(
      access: Awaited<ReturnType<typeof credential>>,
      input: GmailMutationInput,
      readRoute = false,
    ) {
      const kinds = {
        "message.send": "send",
        "draft.create": "draft-create",
        "draft.update": "draft-update",
        "draft.send": "draft-send",
      };
      const intent = input.intent;
      const parsed = parseCommand([
        "gmail",
        kinds[intent.kind],
        "--account",
        intent.accountId,
        "--key",
        input.key,
        "--message",
        JSON.stringify(intent.message),
        ...("draftId" in intent
          ? ["--id", intent.draftId, "--message-id", intent.expectedMessageId]
          : []),
      ]);
      assert.equal(parsed.kind, "request");
      return callGateway(access, parsed.request, (url, init) =>
        Promise.resolve(app.request(readRoute ? "/api/tasks/cli" : new URL(url).pathname, init)),
      );
    }
    async function approve(
      result: CliResult,
      current: Awaited<ReturnType<typeof task>>,
      viaTelegram = false,
    ) {
      assert.equal(result.status, "waiting");
      assert.ok(result.referenceId);
      const id = result.referenceId;
      const action = await database.transaction(ownerId, ({ actions }) => actions.find(id));
      assert.ok(action);
      if (viaTelegram) {
        const card = await database.transaction(ownerId, ({ telegramApprovals }) =>
          telegramApprovals.prepare(id, botId),
        );
        assert.ok(card);
        let count = 0;
        let text = "";
        let token: string | undefined;
        let messageId = 0;
        for (;;) {
          const delivery = await database.transaction(ownerId, ({ telegramOutbound }) =>
            telegramOutbound.claim(botId),
          );
          if (!delivery) break;
          assert.equal(delivery.id, card.outboundId);
          assert.equal(token, undefined, "Buttons must only appear on the final part");
          count++;
          text += delivery.text;
          token = delivery.keyboard?.inline_keyboard[0]?.[0]?.callback_data;
          messageId = 100 + count;
          if (token) {
            assert.equal(
              await database.transaction(ownerId, ({ telegramApprovals }) =>
                telegramApprovals.decide({
                  botId,
                  userId,
                  chatId: userId,
                  token: token ?? "",
                  messageId,
                }),
              ),
              null,
            );
          }
          await database.transaction(ownerId, ({ telegramOutbound }) =>
            telegramOutbound.settle(delivery, { state: "sent", messageId }),
          );
        }
        assert.ok(count > 1);
        assert.ok(token);
        assert.match(text, /private@example.com/);
        assert.match(text, /Exact content/);
        const callback = { botId, userId, chatId: userId, token, messageId };
        assert.equal(
          await database.transaction(ownerId, ({ telegramApprovals }) =>
            telegramApprovals.decide({ ...callback, messageId: 101 }),
          ),
          null,
        );
        assert.deepEqual(
          await database.transaction(ownerId, ({ telegramApprovals }) =>
            telegramApprovals.decide(callback),
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
        email: message.from.email,
        scopes: grant.scopes,
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document) VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      await sql`INSERT INTO winston.telegram_bindings (owner_id, bot_id, user_id, chat_id) VALUES (${ownerId}::uuid, ${botId}, ${userId}, ${userId})`;
      let current = await task();
      let access = await credential(current);
      assert.notEqual((await gateway(access, send, true)).status, "ok");
      const waiting = await gateway(access, send);
      assert.equal(reads, 0);
      assert.equal(writes, 0);
      current = await approve(waiting, current, true);
      assert.equal((await gateway(access, send)).status, "denied");
      access = await credential(current);
      const complete = await gateway(access, send);
      assert.equal(complete.status, "ok");
      assert.equal(writes, 1);
      assert.deepEqual(await gateway(access, send), complete);
      assert.equal(
        (
          await gateway(access, {
            ...send,
            intent: { ...send.intent, message: { ...message, text: "Changed" } },
          })
        ).status,
        "unavailable",
      );
      assert.equal(writes, 1);

      current = await task();
      access = await credential(current);
      const update: GmailMutationInput = {
        key: "draft",
        intent: {
          kind: "draft.update",
          accountId,
          draftId: "draft1",
          expectedMessageId: "message1",
          message,
        },
      };
      const sourceWait = await gateway(access, update);
      assert.equal(reads, 0);
      current = await approve(sourceWait, current);
      access = await credential(current);
      const writeWait = await gateway(access, update);
      assert.equal(reads, 1);
      assert.equal(writes, 1);
      current = await approve(writeWait, current);
      access = await credential(current);
      assert.equal((await gateway(access, update)).status, "ok");
      assert.equal(reads, 2, "One approved content read and one minimal version guard");
      assert.equal(writes, 2);

      current = await task();
      access = await credential(current);
      const reply: GmailMutationInput = {
        key: "reply",
        intent: {
          kind: "message.send",
          accountId,
          message: {
            ...message,
            subject: "Re: Review",
            reply: {
              sourceMessageId: "source1",
              threadId: "thread1",
              inReplyTo: "<source@example.com>",
              references: ["<source@example.com>"],
            },
          },
        },
      };
      current = await approve(await gateway(access, reply), current);
      access = await credential(current);
      current = await approve(await gateway(access, reply), current);
      access = await credential(current);
      assert.equal((await gateway(access, reply)).status, "ok");
      assert.equal(reads, 3, "Reply source is read once across both approval waits");
      assert.equal(writes, 3);

      current = await task();
      access = await credential(current);
      current = await approve(await gateway(access, send), current);
      access = await credential(current);
      loseReply = true;
      const uncertain = await gateway(access, send);
      assert.equal(uncertain.status, "unknown");
      assert.equal((await gateway(access, { ...send, key: "replacement" })).status, "unknown");
      assert.equal((await gateway(access, send)).status, "unknown");
      assert.equal(writes, 4);
      assert.ok(uncertain.referenceId);
      const unknownId = uncertain.referenceId;
      const readWait = await reconcile(access, unknownId, "observe");
      assert.equal(observations, 0);
      current = await approve(readWait, current);
      access = await credential(current);
      assert.equal((await reconcile(access, unknownId, "observe")).status, "unknown");
      assert.equal(observations, 1);
      evidenceMode = "matching";
      assert.equal((await reconcile(access, unknownId, "observe")).status, "unknown");
      assert.equal(observations, 1, "Same observation key preserves its original absence result");
      for (const mode of ["duplicate", "bcc", "malformed", "matching"]) {
        evidenceMode = mode;
        current = await approve(await reconcile(access, unknownId, mode), current);
        access = await credential(current);
        const result = await reconcile(access, unknownId, mode);
        assert.equal(result.status, mode === "matching" ? "ok" : "unknown");
        if (mode === "matching") assert.match(JSON.stringify(result), /does not establish who/);
        assert.equal(writes, 4, "Reconciliation never sends again");
      }
      const beforeCached = observations;
      assert.equal((await reconcile(access, unknownId, "matching")).status, "ok");
      assert.equal(observations, beforeCached);
      assert.equal((await reconcile(access, randomUUID(), "missing-action")).status, "denied");
      assert.equal(
        (await gateway(access, { ...send, key: "after-resolution" })).status,
        "waiting",
        "Verified evidence clears this task's uncertain-write fence",
      );

      // Draft create and update use the draft collection, never a message-send endpoint.
      for (const kind of ["draft.create", "draft.update", "draft.send"] as const) {
        current = await task();
        access = await credential(current);
        const input: GmailMutationInput = {
          key: kind,
          intent:
            kind === "draft.create"
              ? { kind, accountId, message }
              : { kind, accountId, message, draftId: "draft1", expectedMessageId: "message1" },
        };
        let result = await gateway(access, input);
        while (result.status === "waiting") {
          current = await approve(result, current);
          access = await credential(current);
          result = await gateway(access, input);
        }
        assert.equal(result.status, "unknown");
        assert.ok(result.referenceId);
        const priorWrites: number = writes;
        current = await approve(
          await reconcile(access, result.referenceId, "draft-observation"),
          current,
        );
        access = await credential(current);
        assert.equal(
          (await reconcile(access, result.referenceId, "draft-observation")).status,
          "ok",
        );
        assert.equal(writes, priorWrites);
      }

      current = await task();
      access = await credential(current);
      current = await approve(await gateway(access, send), current);
      access = await credential(current);
      const revoked = await gateway(access, send);
      assert.equal(revoked.status, "unknown");
      assert.ok(revoked.referenceId);
      await database.transaction(ownerId, ({ authorization }) =>
        authorization.put({
          revision: 0,
          target: { kind: "connection", id: accountId, resource: null },
          operation: "gmail.read",
          decision: "deny",
        }),
      );
      const beforeDenied = observations;
      assert.equal((await reconcile(access, revoked.referenceId, "revoked")).status, "unknown");
      assert.equal(observations, beforeDenied);
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.find(revoked.referenceId ?? ""),
          )
        )?.state,
        "unknown",
      );
      current = await task();
      access = await credential(current);
      current = await approve(await gateway(access, send), current);
      access = await credential(current);
      const release = Promise.withResolvers<undefined>();
      hold = release.promise;
      const dispatching = gateway(access, send);
      await started.promise;
      try {
        const rows = await sql<
          { id: string }[]
        >`SELECT id::text AS id FROM winston.actions WHERE owner_id = ${ownerId}::uuid AND task_id = ${current.id}::uuid AND document->>'state' = 'dispatching'`;
        assert.ok(rows[0]);
        assert.equal((await reconcile(access, rows[0].id, "in-flight")).status, "unknown");
        assert.equal(observations, beforeDenied);
      } finally {
        release.resolve(undefined);
      }
      assert.equal((await dispatching).status, "unknown");

      const stranger = randomUUID();
      const otherWorkspace = randomUUID();
      const other = await database.transaction(
        stranger,
        async ({ owners, workspaces, tasks, capabilities }) => {
          await owners.ensure();
          await workspaces.register(otherWorkspace, "Other owner");
          await workspaces.setState(otherWorkspace, 0, "active");
          const queued = await tasks.create({
            key: "other",
            objective: "Other owner fixture",
            sourceMessageIds: [],
          });
          const running = await tasks.claim(queued.id, queued.revision);
          return capabilities.issue({
            kind: "workspace",
            subjectId: otherWorkspace,
            resourceId: otherWorkspace,
            resourceRevision: 1,
            taskId: running.id,
            revision: running.revision,
            generation: running.generation,
            operation: "gateway:control",
            credential: null,
          });
        },
      );
      assert.equal(
        (
          await reconcile(
            { ...access, workspaceId: otherWorkspace, controlToken: other.token },
            revoked.referenceId,
            "other-owner",
          )
        ).status,
        "denied",
      );
      assert.equal(observations, beforeDenied);
    } finally {
      await database.close();
    }
  });
});
