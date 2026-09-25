import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { simpleParser } from "mailparser";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createGmailMutationExecutor, prepareGmailMutation } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { GmailMutationIntent } from "@winston/contracts/gmail-mutations";
import { gmailMutationReceiptSchema } from "@winston/contracts/gmail-mutation-responses";
import { withTestPostgres } from "../../src/postgres";

test("Gmail dispatch uses exact approved bytes once and retains ambiguous outcomes", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const grant = {
      accessToken: "synthetic-secret",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.gmail],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 6).toString("base64") }),
    );
    let credentialRevision = 0;
    let rejected = 0;
    let duringAccess: (() => Promise<void>) | undefined;
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: async () => {
        await duringAccess?.();
        return { kind: "ready" as const, grant, revision: credentialRevision };
      },
      rejected: () => {
        rejected += 1;
        return Promise.resolve();
      },
    };
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await vault.put(ownerId, accountId, grant, null);
      const connection: Connection = {
        id: accountId,
        service: "gmail",
        subject: accountId,
        email: "owner@example.com",
        status: "connected",
        revision: 0,
        scopes: grant.scopes,
        calendars: [],
      };
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      async function prepare(
        kind: GmailMutationIntent["kind"] = "message.send",
        approve = true,
        replying = false,
      ) {
        const task = await database.transaction(ownerId, async ({ tasks }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Gmail fixture",
            sourceMessageIds: [],
          });
          return tasks.claim(queued.id, queued.revision);
        });
        const worker = { id: task.id, revision: task.revision, generation: task.generation };
        const target = {
          connectionId: accountId,
          calendarId: null,
          connectionRevision: 0,
          preferencesRevision: 0,
          operation: kind.endsWith("send") ? ("gmail.send" as const) : ("gmail.draft" as const),
          email: connection.email,
          label: "Personal",
          task: { id: task.id, revision: task.revision },
        };
        await database.transaction(ownerId, ({ connectionTargets }) =>
          connectionTargets.bind(
            {
              operation: target.operation,
              task: target.task,
              explicit: { connectionId: accountId, calendarId: null },
            },
            { connectionId: accountId, calendarId: null },
          ),
        );
        const message = {
          from: { email: connection.email },
          to: [{ email: "friend@example.com" }],
          cc: [],
          bcc: [{ email: "private@example.com" }],
          subject: "Approved subject",
          text: "Approved body",
          html: null,
          reply: replying
            ? {
                sourceMessageId: "parent1",
                threadId: "t1",
                inReplyTo: "<parent@example.com>",
                references: ["<parent@example.com>"],
              }
            : null,
          attachments: [],
        };
        const existing = kind === "draft.update" || kind === "draft.send";
        const intent: GmailMutationIntent = existing
          ? { kind, accountId, message, draftId: "draft1", expectedMessageId: "old1" }
          : { kind, accountId, message };
        const prepared = await prepareGmailMutation(
          {
            operationId: randomUUID(),
            preparedAt: "2030-01-01T00:00:00.000Z",
            target,
            intent,
            ...(existing
              ? {
                  draft: {
                    source: { ...target, operation: "gmail.read" as const },
                    id: "draft1",
                    messageId: "old1",
                  },
                }
              : {}),
            ...(replying
              ? {
                  replySource: {
                    source: { ...target, operation: "gmail.read" as const },
                    id: "parent1",
                    threadId: "t1",
                    messageId: "<parent@example.com>",
                    subject: "Approved subject",
                  },
                }
              : {}),
          },
          [],
        );
        const action = await database.transaction(ownerId, ({ gmailActions }) =>
          gmailActions.prepare(worker, randomUUID(), intent, prepared.plan),
        );
        if (approve)
          await database.transaction(ownerId, ({ actions }) =>
            actions.decide({
              id: action.id,
              revision: action.revision,
              hash: action.hash,
              approve: true,
            }),
          );
        return { worker, action, plan: prepared.plan, raw: prepared.raw };
      }
      type Fixture = Awaited<ReturnType<typeof prepare>>;
      const signal = new AbortController().signal;
      const execute = (
        fixture: Fixture,
        provider: (url: URL, init: RequestInit) => Promise<Response>,
      ) =>
        createGmailMutationExecutor({
          database,
          google,
          read: () => Promise.resolve(null),
          fetch: provider,
        })(ownerId, fixture.action.id, fixture.action.hash, fixture.worker, signal);
      for (const kind of ["draft.create", "draft.update", "message.send", "draft.send"] as const) {
        const fixture = await prepare(kind);
        let writes = 0;
        let reads = 0;
        const provider = async (url: URL, init: RequestInit) => {
          assert.equal(url.origin, "https://gmail.googleapis.com");
          assert.equal(init.redirect, "error");
          assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-secret");
          if (init.method === "GET") {
            reads += 1;
            assert.equal(url.pathname, "/gmail/v1/users/me/drafts/draft1");
            assert.equal(url.searchParams.get("format"), "minimal");
            assert.equal(url.searchParams.get("fields"), "id,message(id)");
            return Response.json({ id: "draft1", message: { id: "old1" } });
          }
          writes += 1;
          assert.equal(init.method, fixture.plan.method);
          assert.equal(url.pathname, `/gmail/v1/users/me/${fixture.plan.path}`);
          assert.ok(typeof init.body === "string");
          const body: unknown = JSON.parse(init.body);
          assert.ok(body && typeof body === "object");
          const value = "message" in body ? body.message : body;
          assert.ok(
            value && typeof value === "object" && "raw" in value && typeof value.raw === "string",
          );
          const bytes = Buffer.from(value.raw, "base64url");
          assert.deepEqual(bytes, fixture.raw);
          const parsed = await simpleParser(bytes);
          assert.equal(parsed.subject, "Approved subject");
          assert.equal(parsed.text?.trim(), "Approved body");
          assert.ok(parsed.bcc && !Array.isArray(parsed.bcc));
          assert.equal(parsed.bcc.value[0]?.address, "private@example.com");
          return Response.json(
            kind.endsWith("send")
              ? { id: "sent1", threadId: "t1" }
              : {
                  id: kind === "draft.create" ? "created1" : "draft1",
                  message: { id: "new1", threadId: "t1" },
                },
          );
        };
        const result = await execute(fixture, provider);
        assert.equal(result?.state, "succeeded");
        assert.ok(result.outcome?.providerReference);
        const receipt = gmailMutationReceiptSchema.parse(
          JSON.parse(result.outcome.providerReference),
        );
        assert.equal(receipt.messageId, kind.endsWith("send") ? "sent1" : "new1");
        assert.equal(receipt.kind, kind);
        assert.equal(writes, 1);
        assert.equal(reads, fixture.plan.draft ? 1 : 0);
        assert.equal((await execute(fixture, provider))?.state, "succeeded");
        assert.equal(writes, 1);
      }
      let unexpected = 0;
      const forbidden = () => {
        unexpected += 1;
        return Promise.reject(new Error("unexpected provider access"));
      };
      const pending = await prepare("message.send", false);
      assert.equal((await execute(pending, forbidden))?.state, "pending");
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: pending.action.id,
          revision: pending.action.revision,
          hash: pending.action.hash,
          approve: false,
        }),
      );
      assert.equal((await execute(pending, forbidden))?.state, "denied");
      const canceled = await prepare();
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(canceled.worker.id, canceled.worker.revision),
      );
      await execute(canceled, forbidden);
      const badCredential = await prepare();
      credentialRevision = 10;
      assert.equal((await execute(badCredential, forbidden))?.state, "failed");
      credentialRevision = 0;
      const cancelDuringAccess = await prepare();
      duringAccess = async () => {
        await database.transaction(ownerId, ({ tasks }) =>
          tasks.cancel(cancelDuringAccess.worker.id, cancelDuringAccess.worker.revision),
        );
      };
      assert.equal((await execute(cancelDuringAccess, forbidden))?.state, "failed");
      duringAccess = undefined;
      assert.equal(unexpected, 0);
      const stale = await prepare("draft.send");
      let staleCalls = 0;
      const staleResult = await execute(stale, (_url, init) => {
        staleCalls += 1;
        assert.equal(init.method, "GET");
        return Promise.resolve(Response.json({ id: "draft1", message: { id: "changed" } }));
      });
      assert.equal(staleResult?.state, "failed");
      assert.equal(staleCalls, 1);
      for (const status of [400, 401, 403, 404, 429, 500, 503]) {
        const fixture = await prepare();
        let calls = 0;
        const provider = () => {
          calls += 1;
          return Promise.resolve(new Response("synthetic-secret", { status }));
        };
        const result = await execute(fixture, provider);
        assert.equal(result?.state, status < 500 ? "failed" : "unknown");
        assert.ok(!JSON.stringify(result.outcome).includes("synthetic-secret"));
        await execute(fixture, provider);
        assert.equal(calls, 1);
      }
      assert.equal(rejected, 1);
      for (const provider of [
        () => Promise.reject(new Error("synthetic-secret: reply lost")),
        () => Promise.resolve(Response.json({ id: "unconfirmed" })),
        () => Promise.resolve(new Response("x".repeat(64_001))),
      ]) {
        const fixture = await prepare();
        assert.equal((await execute(fixture, provider))?.state, "unknown");
      }
      const concurrent = await prepare();
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<Response>();
      let calls = 0;
      const provider = () => {
        calls += 1;
        started.resolve(undefined);
        return release.promise;
      };
      const first = execute(concurrent, provider);
      await started.promise;
      assert.equal((await execute(concurrent, provider))?.state, "dispatching");
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(concurrent.worker.id, concurrent.worker.revision),
      );
      release.resolve(Response.json({ id: "sent2", threadId: "t2" }));
      assert.equal((await first)?.state, "succeeded");
      assert.equal(calls, 1);
      const wrongThread = await prepare("message.send", true, true);
      const threadResult = await execute(wrongThread, () =>
        Promise.resolve(Response.json({ id: "sent3", threadId: "another-thread" })),
      );
      assert.equal(threadResult?.state, "unknown");
      assert.ok(threadResult.outcome?.providerReference);
      assert.equal(
        gmailMutationReceiptSchema.parse(JSON.parse(threadResult.outcome.providerReference))
          .messageId,
        "sent3",
      );
      const revoked = await prepare("draft.update");
      const result = await execute(revoked, async (_url, init) => {
        assert.equal(init.method, "GET");
        await database.transaction(ownerId, ({ authorization }) =>
          authorization.put({
            revision: 0,
            target: { kind: "connection", id: accountId, resource: null },
            operation: "gmail.draft",
            decision: "deny",
          }),
        );
        return Response.json({ id: "draft1", message: { id: "old1" } });
      });
      assert.equal(result?.state, "failed");
    } finally {
      await database.close();
    }
  });
});
