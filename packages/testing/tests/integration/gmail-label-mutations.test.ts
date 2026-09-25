import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import {
  createGmailLabelMutationExecutor,
  prepareGmailLabelMutation,
} from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("Gmail labels require exact authority, guard current metadata and dispatch once", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.gmail],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 7).toString("base64") }),
    );
    let credentialRevision = 0;
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: () =>
        Promise.resolve({ kind: "ready" as const, grant, revision: credentialRevision }),
      rejected: () => Promise.resolve(),
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
      await sql`INSERT INTO winston.google_connections (owner_id,id,subject,service,document) VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'gmail',${JSON.stringify(connection)}::text::jsonb)`;
      const label = { id: "custom1", name: "Projects", type: "user" };
      const inbox = { id: "INBOX", name: "INBOX", type: "system" };
      const intent = {
        accountId,
        messageId: "m1",
        addLabelIds: [label.id],
        removeLabelIds: [inbox.id],
      };
      async function prepare(approve = true) {
        const task = await database.transaction(ownerId, async ({ tasks }) => {
          const queued = await tasks.create({
            key: randomUUID(),
            objective: "Organize a message",
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
          operation: "gmail.modify" as const,
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
        const source = { ...target, operation: "gmail.read" as const };
        const plan = prepareGmailLabelMutation(
          randomUUID(),
          target,
          intent,
          {
            source,
            trust: "untrusted_external_content",
            id: "m1",
            threadId: "t1",
            labelIds: ["INBOX"],
          },
          { source, trust: "untrusted_external_content", labels: [label, inbox] },
        );
        const action = await database.transaction(ownerId, ({ gmailLabelActions }) =>
          gmailLabelActions.prepare(worker, "organize", intent, plan),
        );
        assert.equal(
          (
            await database.transaction(ownerId, ({ gmailLabelActions }) =>
              gmailLabelActions.prepare(worker, "organize", intent, null),
            )
          ).id,
          action.id,
        );
        await assert.rejects(
          database.transaction(ownerId, ({ gmailLabelActions }) =>
            gmailLabelActions.find(worker, "organize", { ...intent, removeLabelIds: [] }),
          ),
          /conflicts/,
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
        return { worker, action, plan };
      }
      type Fixture = Awaited<ReturnType<typeof prepare>>;
      const execute = (
        fixture: Fixture,
        provider: (url: URL, init: RequestInit) => Promise<Response>,
      ) =>
        createGmailLabelMutationExecutor({ database, google, fetch: provider })(
          ownerId,
          fixture.action.id,
          fixture.action.hash,
          fixture.worker,
          new AbortController().signal,
        );
      let writes = 0;
      let reads = 0;
      const guard = (url: URL, init: RequestInit) => {
        assert.equal(init.method, "GET");
        reads += 1;
        if (url.pathname.endsWith("messages/m1")) {
          assert.equal(url.searchParams.get("format"), "minimal");
          assert.equal(url.searchParams.get("fields"), "id,threadId,labelIds");
          return Response.json({ id: "m1", threadId: "t1", labelIds: ["INBOX"] });
        }
        assert.equal(url.searchParams.get("fields"), "id,name,type");
        assert.ok(
          ["/gmail/v1/users/me/labels/custom1", "/gmail/v1/users/me/labels/INBOX"].includes(
            url.pathname,
          ),
        );
        return Response.json(url.pathname.endsWith("custom1") ? label : inbox);
      };
      const provider = (url: URL, init: RequestInit) => {
        assert.equal(url.origin, "https://gmail.googleapis.com");
        assert.equal(init.redirect, "error");
        if (init.method === "GET") return Promise.resolve(guard(url, init));
        writes += 1;
        assert.equal(init.method, "POST");
        assert.equal(url.pathname, "/gmail/v1/users/me/messages/m1/modify");
        assert.equal(
          init.body,
          JSON.stringify({ addLabelIds: ["custom1"], removeLabelIds: ["INBOX"] }),
        );
        return Promise.resolve(
          Response.json({ id: "m1", threadId: "t1", labelIds: ["custom1", "STARRED"] }),
        );
      };
      const resume = await prepare(false);
      let resumedTask = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(resume.worker.id, resume.worker.revision, resume.worker.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId: resume.action.id, detail: "Approve labels" },
        }),
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: resume.action.id,
          revision: resume.action.revision,
          hash: resume.action.hash,
          approve: true,
        }),
      );
      resumedTask = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.resume(resumedTask.id, resumedTask.revision, resume.action.id);
        return tasks.claim(queued.id, queued.revision);
      });
      const resumedWorker = {
        id: resumedTask.id,
        revision: resumedTask.revision,
        generation: resumedTask.generation,
      };
      assert.deepEqual(
        (
          await database.transaction(ownerId, ({ gmailLabelActions }) =>
            gmailLabelActions.find(resumedWorker, "organize", intent),
          )
        )?.request.arguments,
        resume.plan,
      );
      const claim = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(resume.action.id, resume.action.hash, resumedWorker),
      );
      assert.ok(claim?.claimed);
      const proof = {
        id: resume.action.id,
        token: claim.token,
        task: resumedWorker,
        authorization: resume.action.request.authorization,
        arguments: resume.action.request.arguments,
      };
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeGmailLabelMutation(proof),
        ),
        true,
      );
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeGmailLabelMutation({ ...proof, token: "wrong" }),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeGmailLabelMutation({ ...proof, task: resume.worker }),
        ),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ actions }) => actions.authorizeGmailMutation(proof)),
        false,
      );
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(stranger, ({ actions }) =>
          actions.authorizeGmailLabelMutation(proof),
        ),
        false,
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(resume.action.id, claim.token, {
          state: "failed",
          detail: "Synthetic proof check only",
          providerReference: null,
        }),
      );
      const fixture = await prepare();
      assert.equal((await execute(fixture, provider))?.state, "succeeded");
      await execute(fixture, provider);
      assert.equal(writes, 1);
      assert.equal(reads, 3);
      let forbiddenCalls = 0;
      const forbidden = () => {
        forbiddenCalls += 1;
        return Promise.reject(new Error("Unexpected provider access"));
      };
      const pending = await prepare(false);
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
      const stale = await prepare();
      credentialRevision = 10;
      assert.equal((await execute(stale, forbidden))?.state, "failed");
      credentialRevision = 0;
      assert.equal(forbiddenCalls, 0);
      for (const metadata of [
        { id: "wrong", threadId: "t1", labelIds: [] },
        { id: "m1", threadId: "wrong", labelIds: [] },
        { id: "m1", threadId: "t1" },
        { id: "m1", threadId: "t1", labelIds: ["TRASH"] },
        { id: "m1", threadId: "t1", labelIds: ["DRAFT"] },
      ]) {
        const changed = await prepare();
        assert.equal(
          (
            await execute(changed, (_url, init) => {
              assert.equal(init.method, "GET");
              return Promise.resolve(Response.json(metadata));
            })
          )?.state,
          "failed",
        );
      }
      const renamed = await prepare();
      assert.equal(
        (
          await execute(renamed, (url, init) => {
            assert.equal(init.method, "GET");
            return Promise.resolve(
              url.pathname.includes("/labels/")
                ? Response.json({ ...label, name: "Renamed" })
                : guard(url, init),
            );
          })
        )?.state,
        "failed",
      );
      for (const response of [
        () => new Response(null, { status: 503 }),
        () => Response.json({ id: "m1", threadId: "t1", labelIds: ["INBOX"] }),
        () => {
          throw new Error("lost response");
        },
      ]) {
        const uncertain = await prepare();
        let attempts = 0;
        const uncertainProvider = (url: URL, init: RequestInit) => {
          if (init.method === "GET") return Promise.resolve(guard(url, init));
          attempts += 1;
          return Promise.resolve(response());
        };
        assert.equal((await execute(uncertain, uncertainProvider))?.state, "unknown");
        await execute(uncertain, uncertainProvider);
        assert.equal(attempts, 1);
        await assert.rejects(
          database.transaction(ownerId, ({ gmailLabelActions }) =>
            gmailLabelActions.prepare(uncertain.worker, "replacement-key", intent, uncertain.plan),
          ),
          /unresolved/,
        );
      }
      const concurrent = await prepare();
      const started = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<Response>();
      let attempts = 0;
      const delayed = (url: URL, init: RequestInit) => {
        if (init.method === "GET") return Promise.resolve(guard(url, init));
        attempts += 1;
        started.resolve(undefined);
        return release.promise;
      };
      const first = execute(concurrent, delayed);
      await started.promise;
      assert.equal((await execute(concurrent, delayed))?.state, "dispatching");
      await database.transaction(ownerId, ({ tasks }) =>
        tasks.cancel(concurrent.worker.id, concurrent.worker.revision),
      );
      release.resolve(Response.json({ id: "m1", threadId: "t1", labelIds: ["custom1"] }));
      assert.equal((await first)?.state, "succeeded");
      assert.equal(attempts, 1);
      const revoked = await prepare();
      assert.equal(
        (
          await execute(revoked, async (url, init) => {
            assert.equal(init.method, "GET");
            await database.transaction(ownerId, ({ authorization }) =>
              authorization.put({
                target: { kind: "connection", id: accountId, resource: null },
                operation: "gmail.modify",
                revision: 0,
                decision: "deny",
              }),
            );
            return guard(url, init);
          })
        )?.state,
        "failed",
      );
    } finally {
      await database.close();
    }
  });
});
