import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createDatabase, migrateDatabase } from "@winston/adapters/database";
import { createCredentialCipher, createCredentialVault } from "@winston/adapters/credentials";
import { createArtifactService, createArtifactStager } from "@winston/adapters/artifacts";
import { createConnectedReadGateway } from "@winston/adapters/google";
import { storedObjectSchema } from "@winston/contracts/storage";
import { artifactStagePlanSchema, artifactTransferSchema } from "@winston/contracts/artifacts";
import { googleScopes, type Connection } from "@winston/contracts/connections";
import { withTestPostgres } from "../../src/postgres";

test("artifact staging fences exact source approval, worker credentials and immutable receipts", async () => {
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
      createCredentialCipher("test", { test: Buffer.alloc(32, 9).toString("base64") }),
    );
    const artifacts = createArtifactService(database, {
      upload: async (owner, source, expected) => {
        for await (const chunk of source) assert.equal(Buffer.from(chunk).toString(), "abc");
        return storedObjectSchema.parse({ ...expected, ownerId: owner });
      },
      verify: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
      downloadUrl: () => Promise.resolve("https://storage.invalid/fixture"),
    });
    let reads = 0;
    const gateway = createConnectedReadGateway({
      database,
      attachmentStore: artifacts,
      google: {
        list: (owner) => database.transaction(owner, ({ connections }) => connections.list()),
        calendars: () => Promise.resolve([]),
        access: () => Promise.resolve({ kind: "ready" as const, grant, revision: 0 }),
        rejected: () => Promise.resolve(),
      },
      fetch: () => {
        reads++;
        return Promise.resolve(
          Response.json({
            id: "message1",
            threadId: "thread1",
            payload: {
              partId: "",
              filename: "report.txt",
              mimeType: "text/plain",
              body: { size: 3, data: "YWJj" },
            },
          }),
        );
      },
    });
    try {
      await database.transaction(
        ownerId,
        async ({ owners, workspaces, workspaceRuntimes, authorization }) => {
          await owners.ensure();
          await workspaces.register(workspaceId, "Transfer fixture");
          await workspaces.setState(workspaceId, 0, "active");
          await workspaceRuntimes.configure({
            workspaceId,
            revision: 1,
            origin: "http://127.0.0.1:9099",
          });
          assert.ok(
            await authorization.put({
              target: { kind: "workspace", id: workspaceId, resource: null },
              operation: "workspace.file.write",
              decision: "ask",
              revision: 0,
            }),
          );
        },
      );
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
      await sql`INSERT INTO winston.google_connections(owner_id,id,subject,service,document)
        VALUES (${ownerId}::uuid,${accountId}::uuid,${accountId},'gmail',${JSON.stringify(connection)}::text::jsonb)`;
      let task = await database.transaction(ownerId, async ({ tasks }) => {
        const queued = await tasks.create({
          key: randomUUID(),
          objective: "Stage a Gmail attachment",
          sourceMessageIds: [],
        });
        return tasks.claim(queued.id, queued.revision);
      });
      const credential = () =>
        database.transaction(ownerId, async ({ capabilities }) => {
          const issued = await capabilities.issue({
            kind: "workspace",
            subjectId: workspaceId,
            resourceId: workspaceId,
            resourceRevision: 2,
            taskId: task.id,
            revision: task.revision,
            generation: task.generation,
            operation: "gateway:control",
            credential: null,
          });
          return {
            id: issued.id,
            request: {
              kind: "workspace" as const,
              subjectId: workspaceId,
              resourceId: workspaceId,
              operation: "gateway:control" as const,
              token: issued.token,
            },
          };
        });
      const approve = (id: string) =>
        database.transaction(ownerId, async ({ actions, tasks }) => {
          const action = await actions.find(id);
          assert.ok(action);
          assert.ok(
            await actions.decide({
              id,
              revision: action.revision,
              hash: action.hash,
              approve: true,
            }),
          );
          const waiting = await tasks.find(task.id);
          assert.ok(waiting);
          const queued = await tasks.resume(task.id, waiting.revision, id);
          task = await tasks.claim(queued.id, queued.revision);
        });
      let access = await credential();
      const readRequest = {
        version: 1 as const,
        command: "gmail.attachment" as const,
        accountId,
        id: "message1",
        partId: "",
        key: "read",
      };
      const signal = new AbortController().signal;
      const pendingRead = await gateway(access.request, readRequest, signal);
      assert.equal(pendingRead.status, "waiting");
      assert.ok(pendingRead.referenceId);
      const readActionId = pendingRead.referenceId;
      await approve(readActionId);
      access = await credential();
      assert.equal((await gateway(access.request, readRequest, signal)).status, "ok");
      const artifact = await database.transaction(ownerId, ({ artifacts }) =>
        artifacts.findByKey(`gmail-attachment:${readActionId}`),
      );
      assert.ok(artifact);
      const input = {
        version: 1 as const,
        key: "stage",
        id: artifact.id,
        revision: artifact.revision,
      };
      const begin = () =>
        database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.begin(access.request, input),
        );
      const pending = await begin();
      assert.equal(pending.status, "waiting");
      await approve(pending.actionId);
      access = await credential();
      const first = await begin();
      assert.equal(first.status, "transfer");
      assert.deepEqual(await database.authenticateArtifactTransfer(first.token), first.transfer);
      assert.equal((await begin()).status, "unknown");
      assert.equal(
        await database.transaction(randomUUID(), ({ artifactTransfers }) =>
          artifactTransfers.authenticate(first.token),
        ),
        null,
      );
      const receipt = {
        path: `/data/inbox/${artifact.id}`,
        size: 3,
        sha256: artifact.metadata.sha256,
      };
      assert.equal(
        await database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.complete(
            first.token,
            { ...first.transfer, artifactId: randomUUID() },
            receipt,
          ),
        ),
        null,
      );
      assert.equal(
        await database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.complete(first.token, first.transfer, {
            ...receipt,
            sha256: "0".repeat(64),
          }),
        ),
        null,
      );
      // Explicit credential revocation fences a still-unexpired transfer token.
      await database.transaction(ownerId, ({ capabilities }) => capabilities.revoke(access.id));
      assert.equal(await database.authenticateArtifactTransfer(first.token), null);
      assert.equal((await begin()).status, "denied");
      access = await credential();
      const renewed = await begin();
      assert.equal(renewed.status, "transfer");
      assert.equal(renewed.transfer.transferId, first.transfer.transferId);
      assert.equal(await database.authenticateArtifactTransfer(first.token), null);
      await database.transaction(ownerId, async ({ tasks, actions }) => {
        const waiting = await tasks.finishStep(task.id, task.revision, task.generation, {
          state: "waiting",
          blocker: {
            kind: "execution",
            referenceId: pending.actionId,
            detail: "Recover interrupted staging",
          },
        });
        assert.equal((await actions.recover(pending.actionId))?.state, "unknown");
        const queued = await tasks.resume(task.id, waiting.revision, pending.actionId);
        task = await tasks.claim(queued.id, queued.revision);
      });
      assert.equal(await database.authenticateArtifactTransfer(renewed.token), null);
      access = await credential();
      const resumed = await begin();
      assert.equal(resumed.status, "transfer");
      assert.notEqual(resumed.transfer.task.generation, first.transfer.task.generation);
      await database.transaction(ownerId, ({ artifactTransfers }) =>
        artifactTransfers.retry(resumed.token),
      );
      assert.equal(await database.authenticateArtifactTransfer(resumed.token), null);
      const expired = await begin();
      assert.equal(expired.status, "transfer");
      await sql`UPDATE winston.artifact_transfers SET expires_at = clock_timestamp() - interval '1 second'
        WHERE owner_id = ${ownerId}::uuid AND id = ${expired.transfer.transferId}::uuid`;
      assert.equal(await database.authenticateArtifactTransfer(expired.token), null);
      const retry = await begin();
      assert.equal(retry.status, "transfer");
      assert.equal(retry.transfer.transferId, first.transfer.transferId);
      assert.deepEqual(
        await database.transaction(ownerId, ({ artifactTransfers }) =>
          artifactTransfers.complete(retry.token, retry.transfer, receipt),
        ),
        receipt,
      );
      assert.equal(await database.authenticateArtifactTransfer(retry.token), null);
      const staged = await begin();
      assert.equal(staged.status, "staged");
      assert.deepEqual(staged.receipt, receipt);
      assert.equal(reads, 1);
      assert.equal(
        (await database.transaction(ownerId, ({ actions }) => actions.find(pending.actionId)))
          ?.state,
        "succeeded",
      );
      assert.equal(
        (
          await database.transaction(ownerId, ({ artifactTransfers }) =>
            artifactTransfers.begin(access.request, { ...input, id: randomUUID() }),
          )
        ).status,
        "denied",
      );
      let storageReads = 0;
      let transfers = 0;
      let readMode = "corrupt";
      const stager = createArtifactStager({
        database,
        read: async (owner, id, maximum, deadline) => {
          assert.equal(owner, ownerId);
          assert.equal(id, artifact.id);
          assert.equal(maximum, 50 * 1024 * 1024);
          assert.ok(deadline);
          assert.equal(deadline.aborted, false);
          storageReads++;
          if (readMode === "revoke")
            await database.transaction(ownerId, ({ capabilities }) =>
              capabilities.revoke(access.id),
            );
          return { artifact, bytes: Buffer.from(readMode === "corrupt" ? "bad" : "abc") };
        },
        send: async (url, init) => {
          transfers++;
          assert.equal(url.href, "http://127.0.0.1:9099/v1/artifacts");
          assert.equal(init.redirect, "error");
          assert.equal(init.credentials, "omit");
          assert.deepEqual(init.body, Buffer.from("abc"));
          const headers = new Headers(init.headers);
          const token = headers.get("Authorization")?.slice(7);
          assert.ok(token);
          const descriptor = artifactTransferSchema.parse(
            JSON.parse(
              Buffer.from(headers.get("X-Winston-Transfer") ?? "", "base64url").toString(),
            ),
          );
          assert.deepEqual(await database.authenticateArtifactTransfer(token), descriptor);
          assert.equal(descriptor.artifactId, artifact.id);
          return Response.json(transfers === 1 ? { ...receipt, size: 4 } : receipt);
        },
      });
      const cliInput = { ...input, key: "cli-stage" };
      const cliPending = await stager(access.request, cliInput, signal);
      assert.equal(cliPending.status, "waiting");
      assert.ok(cliPending.referenceId);
      assert.equal(storageReads, 0);
      await approve(cliPending.referenceId);
      access = await credential();
      assert.equal((await stager(access.request, cliInput, signal)).status, "unknown");
      assert.equal(transfers, 0);
      readMode = "valid";
      const malformed = await stager(access.request, cliInput, signal);
      assert.equal(malformed.status, "unknown");
      readMode = "revoke";
      assert.equal((await stager(access.request, cliInput, signal)).status, "unknown");
      assert.equal(transfers, 1);
      access = await credential();
      readMode = "valid";
      const cliResult = await stager(access.request, cliInput, signal);
      assert.equal(cliResult.status, "ok");
      assert.deepEqual(cliResult.data, {
        artifactId: artifact.id,
        revision: artifact.revision,
        workspaceId,
        path: receipt.path,
        size: 3,
        sha256: artifact.metadata.sha256,
        trust: "untrusted_external_content",
      });
      assert.deepEqual(await stager(access.request, cliInput, signal), cliResult);
      assert.equal(storageReads, 4);
      assert.equal(transfers, 2);
      assert.equal(reads, 1);

      await database.transaction(ownerId, async ({ authorization, actions }) => {
        const current = await authorization.list();
        assert.ok(
          await authorization.put({
            target: { kind: "workspace", id: workspaceId, resource: null },
            operation: "workspace.file.write",
            revision: current.revision,
            decision: "deny",
          }),
        );
        const action = await actions.find(pending.actionId);
        assert.ok(action);
        assert.equal(
          await actions.authorizeArtifactStaging({
            id: action.id,
            transferId: first.transfer.transferId,
            task: { id: task.id, revision: task.revision, generation: task.generation },
            plan: artifactStagePlanSchema.parse(action.request.arguments),
          }),
          false,
        );
      });
      assert.equal((await begin()).status, "denied");
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
      assert.equal((await begin()).status, "denied");
      assert.equal(reads, 1);
    } finally {
      await database.close();
    }
  });
});
