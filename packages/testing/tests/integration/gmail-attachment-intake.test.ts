import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createArtifactService } from "@winston/adapters/artifacts";
import { createConnectedReadGateway } from "@winston/adapters/google";
import { UncertainObjectUpload } from "@winston/adapters/storage";
import { storedObjectSchema } from "@winston/contracts/storage";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("Gmail attachment intake preserves origin and recovers without another provider read", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const database = createDatabase({ connectionString, onConnectionError: () => {} });
    const ownerId = randomUUID();
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    const originalName = "../private/report\u0000.txt";
    let mode = "inline";
    let reads = 0;
    let uploads = 0;
    let verifications = 0;
    let verified = false;
    const grant = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
      scopes: [...googleScopes.gmail],
    };
    const vault = createCredentialVault(
      database,
      createCredentialCipher("test", { test: Buffer.alloc(32, 8).toString("base64") }),
    );
    const artifacts = createArtifactService(database, {
      upload: async (owner, source, expected) => {
        uploads++;
        const chunks: Uint8Array[] = [];
        for await (const chunk of source) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).toString(), "abc");
        const object = storedObjectSchema.parse({ ...expected, ownerId: owner });
        if (mode === "uncertain" || mode === "revoked") throw new UncertainObjectUpload(object);
        return object;
      },
      verify: () => {
        verifications++;
        return Promise.resolve(verified);
      },
      remove: () => Promise.resolve(),
      downloadUrl: () => Promise.resolve("https://storage.invalid/fixture"),
    });
    const google = {
      list: (owner: string) => database.transaction(owner, ({ connections }) => connections.list()),
      calendars: () => Promise.resolve([]),
      access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
      rejected: () => Promise.resolve(),
    };
    const gateway = createConnectedReadGateway({
      database,
      google,
      attachmentStore: artifacts,
      fetch: (url, init) => {
        reads++;
        assert.equal(init.method, "GET");
        assert.equal(url.hostname, "gmail.googleapis.com");
        if (url.pathname.endsWith("/attachments/attachment1"))
          return Promise.resolve(
            Response.json({
              size: 3,
              ...(mode === "missing" ? {} : { data: mode === "corrupt" ? "YQ" : "YWJj" }),
            }),
          );
        assert.ok(url.pathname.endsWith("/messages/message1"));
        return Promise.resolve(
          Response.json({
            id: "message1",
            threadId: "thread1",
            payload: {
              partId: "",
              mimeType: "multipart/mixed",
              body: { size: 0 },
              parts: [
                {
                  partId: "0",
                  filename: originalName,
                  mimeType: "application/octet-stream",
                  body:
                    mode === "inline"
                      ? { size: 3, data: "YWJj" }
                      : {
                          size: mode === "oversized" ? 26 * 1024 * 1024 : 3,
                          attachmentId: "attachment1",
                        },
                },
              ],
            },
          }),
        );
      },
    });
    const start = () =>
      database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Capture attachment",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
    const credential = (task: Awaited<ReturnType<typeof start>>) =>
      database.transaction(ownerId, async ({ capabilities }) => {
        const issued = await capabilities.issue({
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
          kind: "workspace" as const,
          subjectId: workspaceId,
          resourceId: workspaceId,
          operation: "gateway:control" as const,
          token: issued.token,
        };
      });
    const request = {
      version: 1 as const,
      command: "gmail.attachment" as const,
      accountId,
      id: "message1",
      partId: "0",
      key: "attachment",
    };
    try {
      await database.transaction(ownerId, async ({ owners, workspaces }) => {
        await owners.ensure();
        await workspaces.register(workspaceId, "Attachment fixture");
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
      await sql`INSERT INTO winston.google_connections(owner_id,id,subject,service,document) VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'gmail',${JSON.stringify(connection)}::text::jsonb)`;
      for (const scenario of [
        "inline",
        "external",
        "uncertain",
        "corrupt",
        "missing",
        "oversized",
        "deleted",
        "revoked",
      ]) {
        mode = scenario;
        const invalid = ["corrupt", "missing", "oversized"].includes(scenario);
        const expectedReads = ["inline", "oversized"].includes(scenario) ? 1 : 2;
        verified = false;
        const beforeReads: number = reads;
        const beforeUploads: number = uploads;
        let task = await start();
        let access = await credential(task);
        const signal = new AbortController().signal;
        const pending = await gateway(access, request, signal);
        assert.equal(pending.status, "waiting");
        assert.ok(pending.referenceId);
        assert.equal(reads, beforeReads);
        assert.equal(uploads, beforeUploads);
        const actionId = pending.referenceId;
        await database.transaction(ownerId, async ({ actions, tasks }) => {
          const action = await actions.find(actionId);
          assert.ok(action);
          await actions.decide({
            id: action.id,
            revision: action.revision,
            hash: action.hash,
            approve: true,
          });
          const waiting = await tasks.find(task.id);
          assert.ok(waiting);
          const queued = await tasks.resume(task.id, waiting.revision, actionId);
          task = await tasks.claim(queued.id, queued.revision);
        });
        access = await credential(task);
        const result = await gateway(access, request, signal);
        assert.equal(
          result.status,
          invalid || ["uncertain", "revoked"].includes(scenario) ? "unknown" : "ok",
          `${scenario}: reads=${String(reads - beforeReads)}, uploads=${String(uploads - beforeUploads)}`,
        );
        assert.equal(reads, beforeReads + expectedReads);
        assert.equal(uploads, beforeUploads + (invalid ? 0 : 1));
        const stored = await database.transaction(ownerId, ({ artifacts }) =>
          artifacts.findByKey(`gmail-attachment:${actionId}`),
        );
        if (stored) {
          if (scenario === "inline") {
            await sql`UPDATE winston.connected_read_results SET result = result #- '{data,revision}'
              WHERE owner_id = ${ownerId}::uuid AND action_id = ${actionId}::uuid`;
          }
          assert.equal(
            await database.transaction(ownerId, ({ connectedReads }) =>
              connectedReads.reconcileAttachment(access, actionId, stored.id, {
                ...request,
                accountId: randomUUID(),
              }),
            ),
            null,
          );
          assert.equal(
            await database.transaction(ownerId, ({ connectedReads }) =>
              connectedReads.reconcileAttachment(access, actionId, randomUUID(), request),
            ),
            null,
          );
        }
        if (scenario === "deleted") {
          assert.ok(stored);
          await database.transaction(ownerId, async ({ artifacts }) => {
            const deleting = await artifacts.beginDelete(stored.id, stored.revision);
            assert.ok(deleting);
            assert.ok(await artifacts.finishDelete(deleting.id, deleting.revision));
          });
        }
        if (scenario === "revoked") {
          await database.transaction(ownerId, async ({ authorization }) => {
            const current = await authorization.list();
            assert.ok(
              await authorization.put({
                target: { kind: "connection", id: accountId, resource: null },
                operation: "gmail.read",
                revision: current.revision,
                decision: "deny",
              }),
            );
          });
        }
        verified = true;
        const beforeVerifications = verifications;
        const recovered = await gateway(access, request, signal);
        assert.equal(
          recovered.status,
          scenario === "revoked"
            ? "unavailable"
            : invalid || scenario === "deleted"
              ? "unknown"
              : "ok",
        );
        assert.equal(reads, beforeReads + expectedReads);
        assert.equal(uploads, beforeUploads + (invalid ? 0 : 1));
        if (scenario === "revoked") {
          assert.equal(verifications, beforeVerifications);
          assert.ok(stored);
          assert.equal(
            await database.transaction(ownerId, ({ connectedReads }) =>
              connectedReads.reconcileAttachment(access, actionId, stored.id, request),
            ),
            null,
          );
        }
        if (recovered.status === "ok") {
          assert.ok(
            recovered.data && typeof recovered.data === "object" && !Array.isArray(recovered.data),
          );
          assert.equal(recovered.data.name, "_private_report_.txt");
          assert.ok(stored);
          const ready = await database.transaction(ownerId, ({ artifacts }) =>
            artifacts.find(stored.id),
          );
          assert.equal(recovered.data.revision, ready?.revision);
          assert.ok(
            JSON.stringify(recovered.data).includes(JSON.stringify(JSON.stringify(originalName))),
          );
          assert.ok(JSON.stringify(recovered.data).includes(actionId));
          assert.ok(!JSON.stringify(recovered.data).includes("synthetic"));
        }
      }
    } finally {
      await database.close();
    }
  });
});
