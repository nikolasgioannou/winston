import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createArtifactService, createWorkspaceFilePublisher } from "@winston/adapters/artifacts";
import { UncertainObjectUpload } from "@winston/adapters/storage";
import { storedObjectSchema } from "@winston/contracts/storage";
import { withTestPostgres } from "../../src/postgres";

test("exact file approval resumes once and reconciles storage without another upload", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    let uploads = 0;
    let consumed = 0;
    let uncertain = false;
    let verified = false;
    const artifacts = createArtifactService(database, {
      upload: async (owner, source, expected) => {
        uploads++;
        for await (const chunk of source) assert.equal(Buffer.from(chunk).toString(), "abc");
        const object = storedObjectSchema.parse({ ...expected, ownerId: owner });
        if (uncertain) throw new UncertainObjectUpload(object);
        return object;
      },
      verify: () => Promise.resolve(verified),
      remove: () => Promise.resolve(),
      downloadUrl: () => Promise.resolve("https://storage.invalid/fixture"),
    });
    const publish = createWorkspaceFilePublisher({ database, artifacts });
    const input = {
      version: 1 as const,
      key: "report",
      name: "report.txt",
      mediaType: "text/plain",
      size: 3,
      sha256: createHash("sha256").update("abc").digest("hex"),
    };
    function* bytes() {
      consumed++;
      yield Buffer.from("abc");
    }
    const signal = new AbortController().signal;
    const start = () =>
      database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Publish approved file",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    const credential = (task: Awaited<ReturnType<typeof start>>) =>
      database.transaction(ownerId, async ({ capabilities }) => {
        const grant = await capabilities.issue({
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 1,
          taskId: task.id,
          revision: task.revision,
          generation: task.generation,
          operation: "gateway:control",
          credential: null,
        });
        return {
          token: grant.token,
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation: "gateway:control" as const,
        };
      });
    const resume = (id: string, actionId: string) =>
      database.transaction(ownerId, async ({ tasks }) => {
        const task = await tasks.find(id);
        assert.ok(task);
        const queued = await tasks.resume(id, task.revision, actionId);
        return tasks.claim(id, queued.revision);
      });
    try {
      await database.transaction(ownerId, async ({ owners, workspaces, authorization }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Approval fixture");
        await workspaces.setState(workspaceId, 0, "active");
        assert.ok(
          await authorization.put({
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.file.read",
            decision: "ask",
            revision: 0,
          }),
        );
      });
      for (const scenario of ["success", "unknown", "denied", "expired"]) {
        uncertain = scenario === "unknown";
        verified = false;
        let task = await start();
        let access = await credential(task);
        const beforeUploads: number = uploads;
        const beforeConsumed = consumed;
        const pending = await publish(access, input, bytes(), signal);
        assert.equal(pending.status, "waiting");
        assert.ok(pending.referenceId);
        const actionId = pending.referenceId;
        assert.equal(uploads, beforeUploads);
        assert.equal(consumed, beforeConsumed);
        await database.transaction(ownerId, async ({ actions }) => {
          const action = await actions.find(actionId);
          assert.ok(action);
          assert.deepEqual(action.request.arguments, input);
          await actions.decide({
            id: action.id,
            revision: action.revision,
            hash: action.hash,
            approve: scenario !== "denied",
          });
        });
        if (scenario === "expired")
          await sql`UPDATE winston.actions SET expires_at = clock_timestamp() - interval '1 second' WHERE owner_id = ${ownerId}::uuid AND id = ${actionId}::uuid`;
        task = await resume(task.id, actionId);
        access = await credential(task);
        if (scenario === "success") {
          assert.equal(
            (await publish(access, { ...input, name: "different.txt" }, bytes(), signal)).status,
            "unavailable",
          );
          assert.equal(uploads, beforeUploads);
        }
        const result = await publish(access, input, bytes(), signal);
        if (scenario === "denied" || scenario === "expired") {
          assert.equal(result.status, "denied");
          assert.equal(uploads, beforeUploads);
          assert.equal(consumed, beforeConsumed);
          continue;
        }
        assert.equal(result.status, scenario === "success" ? "ok" : "unknown");
        assert.equal(uploads, beforeUploads + 1);
        verified = true;
        const repeated = await publish(access, input, bytes(), signal);
        assert.equal(repeated.status, "ok");
        assert.equal(uploads, beforeUploads + 1);
        assert.equal(consumed, beforeConsumed + 1);
        if (scenario === "success") assert.deepEqual(repeated, result);
        const action = await database.transaction(ownerId, ({ actions }) => actions.find(actionId));
        assert.equal(action?.state, "succeeded");
        assert.ok(action.outcome?.providerReference);
        // A changed current policy cannot reuse a prior owner approval or expose its receipt.
        await database.transaction(ownerId, async ({ authorization }) => {
          const policy = await authorization.list();
          assert.ok(
            await authorization.put({
              target: { kind: "workspace", id: workspaceId, resource: null },
              operation: "workspace.file.read",
              decision: "deny",
              revision: policy.revision,
            }),
          );
        });
        assert.equal((await publish(access, input, bytes(), signal)).status, "denied");
        await database.transaction(ownerId, async ({ authorization }) => {
          const policy = await authorization.list();
          assert.ok(
            await authorization.put({
              target: { kind: "workspace", id: workspaceId, resource: null },
              operation: "workspace.file.read",
              decision: "ask",
              revision: policy.revision,
            }),
          );
        });
      }
    } finally {
      await database.close();
    }
  });
});
