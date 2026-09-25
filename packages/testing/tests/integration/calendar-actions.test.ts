import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { prepareCalendarMutation } from "@winston/adapters/google";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import type { CalendarMutationIntent } from "@winston/contracts/calendar-mutations";
import type { ActionRequest } from "@winston/contracts/actions";
import { withTestPostgres } from "../../src/postgres";

test("Calendar approvals retain exact plans across resume and fence dispatch authority", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const calendarId = "work@example.com";
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 7).toString("base64") }),
    );
    try {
      await database.transaction(ownerId, ({ owners }) => owners.ensure());
      const connection: Connection = {
        id: accountId,
        service: "calendar",
        subject: accountId,
        email: "approval@example.com",
        scopes: [...googleScopes.calendar],
        status: "connected",
        revision: 0,
        calendars: [calendarId],
      };
      await vault.put(
        ownerId,
        accountId,
        {
          accessToken: "synthetic-access",
          refreshToken: "synthetic-refresh",
          expiresAt: "2030-01-01T00:00:00.000Z",
          scopes: connection.scopes,
        },
        null,
      );
      await sql`INSERT INTO winston.google_connections (owner_id, id, subject, service, document)
        VALUES (${ownerId}::uuid, ${accountId}::uuid, ${accountId}, 'calendar', ${JSON.stringify(connection)}::text::jsonb)`;

      let task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Create meeting",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const originalWorker = { id: task.id, revision: task.revision, generation: task.generation };
      const target = {
        connectionId: accountId,
        calendarId,
        operation: "calendar.write" as const,
        connectionRevision: 0,
        preferencesRevision: 0,
        email: connection.email,
        label: "Work",
        task: { id: task.id, revision: task.revision },
      };
      const intent: Extract<CalendarMutationIntent, { kind: "create" }> = {
        kind: "create" as const,
        accountId,
        calendarId,
        sendUpdates: "all" as const,
        event: {
          summary: "Review",
          description: "",
          location: "",
          timing: {
            kind: "all-day",
            start: "2026-10-01",
            end: "2026-10-02",
            timezone: "America/New_York",
          },
          attendees: [{ email: "guest@example.com" }],
          recurrence: [],
          transparency: "opaque",
        },
      };
      const plan = prepareCalendarMutation(randomUUID(), {
        kind: intent.kind,
        target,
        sendUpdates: intent.sendUpdates,
        event: intent.event,
      });
      const key = "create-review";
      const prepare = (worker = originalWorker, input = intent, candidate: unknown = plan) =>
        database.transaction(ownerId, ({ calendarActions }) =>
          calendarActions.prepare(worker, key, input, candidate),
        );
      await assert.rejects(prepare(), /binding/);
      await database.transaction(ownerId, ({ connectionTargets }) =>
        connectionTargets.bind(
          {
            operation: target.operation,
            task: target.task,
            explicit: { connectionId: accountId, calendarId },
          },
          { connectionId: accountId, calendarId },
        ),
      );
      await assert.rejects(
        prepare(originalWorker, intent, { ...plan, body: { summary: "Unreviewed" } }),
        /reviewed/,
      );
      const action = await prepare();
      assert.equal(action.state, "pending");
      assert.equal(action.operationId, plan.operationId);
      assert.deepEqual(action.request.arguments, { intent, plan });
      assert.equal((await prepare()).id, action.id);
      await assert.rejects(
        database.transaction(ownerId, ({ calendarActions }) =>
          calendarActions.prepare(originalWorker, "different-key", intent, plan),
        ),
        /already in use/,
      );
      await assert.rejects(
        prepare(originalWorker, { ...intent, sendUpdates: "none" }),
        /conflicts/,
      );
      await assert.rejects(
        database.transaction(ownerId, ({ actions }) =>
          actions.prepare(action.request, { operationId: randomUUID() }),
        ),
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
          blocker: { kind: "approval", referenceId: action.id, detail: "Approve meeting" },
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
      const found = await database.transaction(ownerId, ({ calendarActions }) =>
        calendarActions.find(worker, key, intent),
      );
      assert.equal(found?.id, action.id);
      assert.deepEqual(found.request.arguments, action.request.arguments);
      // Resuming does not read new provider state or replace the already-reviewed plan.
      assert.equal((await prepare(worker, intent, null)).operationId, plan.operationId);
      await assert.rejects(prepare(), /stale/);
      const claimed = await database.transaction(ownerId, ({ actions }) =>
        actions.claim(action.id, action.hash, worker),
      );
      assert.ok(claimed?.claimed);
      const proof: {
        id: string;
        token: string;
        task: ActionRequest["task"];
        authorization: ActionRequest["authorization"];
        arguments: ActionRequest["arguments"];
      } = {
        id: action.id,
        token: claimed.token,
        task: worker,
        authorization: action.request.authorization,
        arguments: action.request.arguments,
      };
      const check = (input = proof) =>
        database.transaction(ownerId, ({ actions }) => actions.authorizeCalendarMutation(input));
      assert.equal(await check(), true);
      assert.equal(await check({ ...proof, token: "wrong" }), false);
      assert.equal(await check({ ...proof, task: originalWorker }), false);
      assert.equal(
        await check({
          ...proof,
          authorization: {
            ...proof.authorization,
            target: { ...proof.authorization.target, resource: "other@example.com" },
          },
        }),
        false,
      );
      assert.equal(await check({ ...proof, arguments: { changed: true } }), false);
      assert.equal(
        await database.transaction(ownerId, ({ actions }) =>
          actions.authorizeConnectionRead(proof),
        ),
        false,
      );
      const stranger = randomUUID();
      await database.transaction(stranger, ({ owners }) => owners.ensure());
      assert.equal(
        await database.transaction(stranger, ({ actions }) =>
          actions.authorizeCalendarMutation(proof),
        ),
        false,
      );

      await database.transaction(ownerId, ({ connectionTargets }) =>
        connectionTargets.put({ revision: 0, defaults: [], labels: [] }),
      );
      assert.equal(await check(), false);
      // Restore the fixture revision to isolate the next independent fence.
      await sql`DELETE FROM winston.connection_target_preferences WHERE owner_id = ${ownerId}::uuid`;
      assert.equal(await check(), true);
      await sql`UPDATE winston.google_connections SET document = jsonb_set(document, '{revision}', '1') WHERE owner_id = ${ownerId}::uuid AND id = ${accountId}::uuid`;
      assert.equal(await check(), false);
      await sql`UPDATE winston.google_connections SET document = jsonb_set(document, '{revision}', '0') WHERE owner_id = ${ownerId}::uuid AND id = ${accountId}::uuid`;
      assert.equal(await check(), true);
      const rollback = new Error("Roll back the independent policy fixture.");
      await assert.rejects(
        database.transaction(ownerId, async ({ authorization, actions }) => {
          await authorization.put({ ...proof.authorization, revision: 0, decision: "deny" });
          assert.equal(await actions.authorizeCalendarMutation(proof), false);
          throw rollback;
        }),
        (error) => error === rollback,
      );
      assert.equal(await check(), true);
      await database.transaction(ownerId, ({ tasks }) => tasks.cancel(task.id, task.revision));
      assert.equal(await check(), false);
      const recovered = await database.transaction(ownerId, ({ actions }) =>
        actions.recover(action.id),
      );
      assert.equal(recovered?.state, "unknown");
      assert.equal(
        (
          await database.transaction(ownerId, ({ actions }) =>
            actions.claim(action.id, action.hash, worker),
          )
        )?.claimed,
        false,
      );
      assert.equal(await check(), false);
    } finally {
      await database.close();
    }
  });
});
