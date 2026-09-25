import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { prepareGmailMutation } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { GmailMutationIntent } from "@winston/contracts/gmail-mutations";
import type { ActionRequest } from "@winston/contracts/actions";
import { withTestPostgres } from "../../src/postgres";

test("Gmail approvals retain exact content across resume and fence uncertain writes", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const stranger = randomUUID();
    const accountId = randomUUID();
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 4).toString("base64") }),
    );
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      const connection: Connection = {
        id: accountId,
        service: "gmail",
        subject: accountId,
        email: "approval@example.com",
        scopes: [...googleScopes.gmail],
        status: "connected",
        revision: 0,
        calendars: [],
      };
      await vault.put(
        ownerId,
        accountId,
        {
          accessToken: "synthetic",
          refreshToken: "synthetic",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: connection.scopes,
        },
        null,
      );
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'gmail', ${JSON.stringify(connection)}::text::jsonb)`;
      const bytes = Buffer.from("Exact attachment");
      const artifact = await database.transaction(ownerId, async ({ artifacts }) => {
        const pending = await artifacts.prepare("attachment", {
          name: "report.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          source: { kind: "workspace", reference: "synthetic" },
        });
        const ready = await artifacts.ready(pending.artifact.id, pending.artifact.revision);
        assert.ok(ready);
        return ready;
      });
      let task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Send an email",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const originalWorker = { id: task.id, revision: task.revision, generation: task.generation };
      const target = {
        connectionId: accountId,
        calendarId: null,
        operation: "gmail.send" as const,
        connectionRevision: 0,
        preferencesRevision: 0,
        email: connection.email,
        label: "Personal",
        task: { id: task.id, revision: task.revision },
      };
      const intent: GmailMutationIntent = {
        kind: "message.send",
        accountId,
        message: {
          from: { email: connection.email },
          to: [{ email: "recipient@example.com" }],
          cc: [],
          bcc: [],
          subject: "Report",
          text: "Exact message",
          html: null,
          reply: null,
          attachments: [
            {
              artifactId: artifact.id,
              revision: artifact.revision,
              name: artifact.metadata.name,
              mediaType: artifact.metadata.mediaType,
              size: artifact.metadata.size,
              sha256: artifact.metadata.sha256,
            },
          ],
        },
      };
      const contents = [{ artifactId: artifact.id, revision: artifact.revision, bytes }];
      const plan = (
        await prepareGmailMutation(
          { operationId: randomUUID(), preparedAt: "2030-01-01T00:00:00.000Z", target, intent },
          contents,
        )
      ).plan;
      const prepare = (
        worker = originalWorker,
        input = intent,
        candidate: unknown = plan,
        key = "send-report",
      ) =>
        database.transaction(ownerId, ({ gmailActions }) =>
          gmailActions.prepare(worker, key, input, candidate),
        );
      await assert.rejects(prepare(), /binding/);
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
      await assert.rejects(prepare(originalWorker, intent, { ...plan, path: "messages/delete" }));
      const foreignArtifactId = randomUUID();
      const foreignIntent = {
        ...intent,
        message: {
          ...intent.message,
          attachments: intent.message.attachments.map((attachment) => ({
            ...attachment,
            artifactId: foreignArtifactId,
          })),
        },
      };
      const foreignPlan = (
        await prepareGmailMutation(
          {
            operationId: randomUUID(),
            preparedAt: "2030-01-01T00:00:00.000Z",
            target,
            intent: foreignIntent,
          },
          [{ artifactId: foreignArtifactId, revision: artifact.revision, bytes }],
        )
      ).plan;
      await assert.rejects(
        prepare(originalWorker, foreignIntent, foreignPlan),
        /attachment changed/,
      );
      const action = await prepare();
      assert.equal(action.state, "pending");
      assert.equal(action.operationId, plan.prepared.operationId);
      assert.deepEqual(action.request.arguments, plan);
      assert.equal((await prepare()).id, action.id);
      await assert.rejects(
        prepare(originalWorker, {
          ...intent,
          message: { ...intent.message, bcc: [{ email: "other@example.com" }] },
        }),
        /conflicts/,
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, originalWorker),
          )
        )?.claimed,
        false,
      );
      task = await database.transaction(ownerId, ({ tasks }) =>
        tasks.finishStep(task.id, task.revision, task.generation, {
          state: "waiting",
          blocker: { kind: "approval", referenceId: action.id, detail: "Approve email" },
        }),
      );
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: action.id,
          revision: action.revision,
          hash: action.hash,
          approve: true,
        }),
      );
      task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.resume(task.id, task.revision, action.id);
        return tasks.claim(queued.id, queued.revision);
      });
      const worker = { id: task.id, revision: task.revision, generation: task.generation };
      const found = await database.transaction(ownerId, ({ gmailActions }) =>
        gmailActions.find(worker, "send-report", intent),
      );
      assert.deepEqual(found?.request.arguments, plan);
      assert.equal((await prepare(worker, intent, null)).operationId, plan.prepared.operationId);
      await assert.rejects(prepare(), /stale/);
      const nextTarget = { ...target, task: { id: worker.id, revision: worker.revision } };
      const nextPlan = (
        await prepareGmailMutation(
          {
            operationId: randomUUID(),
            preparedAt: "2030-01-01T01:00:00.000Z",
            target: nextTarget,
            intent,
          },
          contents,
        )
      ).plan;
      const second = await prepare(worker, intent, nextPlan, "second-send");
      await database.transaction(ownerId, ({ actions }) =>
        actions.decide({
          id: second.id,
          revision: second.revision,
          hash: second.hash,
          approve: true,
        }),
      );
      const claims = await Promise.all(
        [0, 1].map(() =>
          database.transaction(ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          ),
        ),
      );
      assert.equal(claims.filter((claim) => claim?.claimed).length, 1);
      const claim = claims.find((result) => result?.claimed);
      assert.ok(claim?.claimed);
      const proof: {
        id: string;
        token: string;
        task: ActionRequest["task"];
        authorization: ActionRequest["authorization"];
        arguments: ActionRequest["arguments"];
      } = {
        id: action.id,
        token: claim.token,
        task: worker,
        authorization: action.request.authorization,
        arguments: action.request.arguments,
      };
      const check = (input = proof) =>
        database.transaction(ownerId, ({ actions }) => actions.authorizeGmailMutation(input));
      assert.equal(await check(), true);
      assert.equal(await check({ ...proof, token: "wrong" }), false);
      assert.equal(await check({ ...proof, task: originalWorker }), false);
      assert.equal(await check({ ...proof, arguments: { changed: true } }), false);
      assert.equal(
        await check({
          ...proof,
          authorization: { ...proof.authorization, operation: "gmail.draft" },
        }),
        false,
      );
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeConnectionRead(proof),
        ),
        false,
      );
      assert.equal(
        await database.transaction(stranger, ({ actions }) =>
          actions.authorizeGmailMutation(proof),
        ),
        false,
      );
      const rollback = new Error("Restore independent fixture");
      await assert.rejects(
        database.transaction(ownerId, async ({ artifacts, actions }) => {
          await artifacts.beginDelete(artifact.id, artifact.revision);
          assert.equal(await actions.authorizeGmailMutation(proof), false);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(await check(), true);
      await assert.rejects(
        database.transaction(ownerId, async ({ authorization, actions }) => {
          await authorization.put({ ...proof.authorization, revision: 0, decision: "deny" });
          assert.equal(await actions.authorizeGmailMutation(proof), false);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      await assert.rejects(
        database.transaction(ownerId, async ({ connectionTargets, actions }) => {
          await connectionTargets.put({ revision: 0, labels: [], defaults: [] });
          assert.equal(await actions.authorizeGmailMutation(proof), false);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      await assert.rejects(
        database.transaction(ownerId, async ({ tasks, actions }) => {
          await tasks.cancel(task.id, task.revision);
          assert.equal(await actions.authorizeGmailMutation(proof), false);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      await sql`UPDATE winston.google_connections SET document = jsonb_set(document, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${accountId}::uuid`;
      assert.equal(await check(), false);
      await sql`UPDATE winston.google_connections SET document = jsonb_set(document, '{revision}', '0') WHERE owner_id = ${ownerId}::uuid AND id = ${accountId}::uuid`;
      assert.equal(await check(), true);
      await database.transaction(ownerId, ({ actions }) =>
        actions.report(action.id, claim.token, {
          state: "unknown",
          detail: "Reply lost",
          providerReference: null,
        }),
      );
      await assert.rejects(prepare(worker, intent, nextPlan, "new-key"), /unresolved/);
      await assert.rejects(
        database.transaction(ownerId, ({ actions }) =>
          actions.claim(second.id, second.hash, worker),
        ),
        /unresolved/,
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          )
        )?.claimed,
        false,
      );
      assert.equal(await check(), false);
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      assert.equal(await check(), false);
    } finally {
      await database.close();
    }
  });
});
