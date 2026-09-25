import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { createDatabase } from "@winston/adapters/database";
import {
  createArtifactService,
  createDeviceFileReceiver,
  createWorkspaceFilePublisher,
} from "@winston/adapters/artifacts";
import { storedObjectSchema } from "@winston/contracts/storage";
import { artifactSchema } from "@winston/contracts/artifacts";
import { deviceOperationSchema, type DeviceMessage } from "@winston/contracts/devices";
import type { DeviceServerIdentity } from "@winston/contracts/device-registry";

export async function deviceWriteFixture(
  database: ReturnType<typeof createDatabase>,
  originPort: number,
  sourceKind: "workspace" | "device" = "workspace",
  content = Buffer.from("write fixture"),
  server?: DeviceServerIdentity,
) {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  const initialized = await database.transaction(ownerId, async (scope) => {
    await scope.owners.ensure();
    await scope.workspaces.register(workspaceId, "Write fixture");
    await scope.workspaces.setState(workspaceId, 0, "active");
    await scope.workspaceRuntimes.configure({
      workspaceId,
      revision: 1,
      origin: `http://127.0.0.1:${String(originPort)}`,
    });
    for (const operation of ["workspace.file.read", "workspace.file.write"] as const) {
      const policy = await scope.authorization.list();
      assert.ok(
        await scope.authorization.put({
          target: { kind: "workspace", id: workspaceId, resource: null },
          operation,
          decision: "allow",
          revision: policy.revision,
        }),
      );
    }
    const queued = await scope.tasks.create({
      key: randomUUID(),
      objective: "Write fixture",
      sourceMessageIds: [],
    });
    const running = await scope.tasks.claim(queued.id, queued.revision);
    const challenge = await scope.devices.start("Fixture Mac");
    const pair = await scope.devices.pair(challenge.secret, {
      platform: "macos",
      appVersion: "0.1.0",
      protocolVersion: 1,
      capabilities: ["file.read", "file.write"],
    });
    assert.ok(pair);
    const opened = await scope.deviceSessions.open(pair.device.id, pair.credential, server);
    assert.ok(opened);
    const session = {
      deviceId: opened.deviceId,
      sessionId: opened.sessionId,
      generation: opened.generation,
    };
    await scope.deviceSessions.advertise(session, ["file.read", "file.write"]);
    await scope.deviceSessions.heartbeat(session, "ready");
    return {
      worker: { id: running.id, revision: running.revision, generation: running.generation },
      session,
    };
  });
  let worker = initialized.worker;
  const session = initialized.session;
  const issue = () =>
    database.transaction(ownerId, async ({ capabilities }) => {
      const grant = await capabilities.issue(
        {
          kind: "workspace",
          subjectId: workspaceId,
          resourceId: workspaceId,
          resourceRevision: 2,
          taskId: worker.id,
          revision: worker.revision,
          generation: worker.generation,
          operation: "gateway:control",
          credential: null,
        },
        300,
      );
      return {
        token: grant.token,
        kind: "workspace" as const,
        subjectId: workspaceId,
        resourceId: workspaceId,
        operation: "gateway:control" as const,
      };
    });
  let credential = await issue();
  const artifacts = createArtifactService(database, {
    async upload(owner, chunks, expected) {
      const collected: Uint8Array[] = [];
      for await (const chunk of chunks) collected.push(chunk);
      assert.deepEqual(Buffer.concat(collected), content);
      return storedObjectSchema.parse({ ...expected, ownerId: owner });
    },
    verify: () => Promise.resolve(true),
    remove: () => {
      throw new Error("No external deletion");
    },
    downloadUrl: () => {
      throw new Error("No external download");
    },
  });
  let artifactId: string;
  if (sourceKind === "workspace") {
    const publish = createWorkspaceFilePublisher({ database, artifacts });
    const result = await publish(
      credential,
      {
        version: 1,
        key: "source",
        name: "report.txt",
        mediaType: "text/plain",
        size: content.length,
        sha256,
      },
      [content],
      new AbortController().signal,
    );
    assert.equal(result.status, "ok");
    assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
    artifactId = artifactSchema.shape.id.parse(result.data.artifactId);
  } else {
    const read = await database.transaction(ownerId, async (scope) => {
      const operation = {
        kind: "file.read" as const,
        path: "/fixtures/original.txt",
        transferId: randomUUID(),
      };
      const action = await scope.deviceActions.prepare(
        worker,
        "capture",
        session.deviceId,
        operation,
      );
      await scope.actions.decide({
        id: action.id,
        revision: action.revision,
        hash: action.hash,
        approve: true,
      });
      const message: DeviceMessage = {
        version: 1,
        ...session,
        messageId: randomUUID(),
        correlationId: randomUUID(),
        payload: {
          kind: "execute",
          executionId: action.operationId,
          taskId: worker.id,
          taskRevision: worker.revision,
          deadline: Date.now() + 60_000,
          operation,
        },
      };
      assert.equal(
        (
          await scope.deviceExecutions.reserveApproved({
            id: action.id,
            hash: action.hash,
            task: worker,
            message,
          })
        ).status,
        "reserved",
      );
      return { action, message, operation };
    });
    const receive = createDeviceFileReceiver({ database, artifacts });
    const captured = await receive(
      ownerId,
      session.deviceId,
      {
        version: 1,
        authority: {
          session,
          executionId: read.action.operationId,
          transferId: read.operation.transferId,
          operation: "file.read",
        },
        size: content.length,
        sha256,
      },
      [content],
      new AbortController().signal,
    );
    assert.ok(captured.status === "ready");
    artifactId = captured.artifactId;
    await database.transaction(ownerId, async (scope) => {
      await scope.deviceExecutions.receipt({
        ...read.message,
        messageId: randomUUID(),
        correlationId: read.message.messageId,
        payload: {
          kind: "status",
          executionId: read.action.operationId,
          taskId: worker.id,
          taskRevision: worker.revision,
          sequence: 0,
          state: "succeeded",
          exitCode: 0,
        },
      });
      const stage = await scope.artifactTransfers.begin(credential, {
        version: 1,
        key: "stage",
        id: captured.artifactId,
        revision: captured.revision,
      });
      assert.equal(stage.status, "transfer");
      assert.ok(
        await scope.artifactTransfers.complete(stage.token, stage.transfer, {
          path: `/data/inbox/${captured.artifactId}`,
          size: content.length,
          sha256,
        }),
      );
    });
  }
  const artifact = await database.transaction(ownerId, ({ artifacts: records }) =>
    records.find(artifactId),
  );
  assert.ok(artifact && artifact.state === "ready");
  const request = {
    version: 1 as const,
    id: session.deviceId,
    key: "write",
    path: "/fixtures/destination.txt",
    overwrite: false,
    artifactId,
    revision: artifact.revision,
  };
  const pending = await database.transaction(ownerId, ({ deviceFileWrites }) =>
    deviceFileWrites.prepare(credential, request),
  );
  assert.ok(pending && pending.action.state === "pending");
  const before = deviceOperationSchema.parse(pending.action.request.arguments);
  assert.equal(before.kind, "file.write");
  worker = await database.transaction(ownerId, async ({ actions, tasks }) => {
    await tasks.finishStep(worker.id, worker.revision, worker.generation, {
      state: "waiting",
      blocker: {
        kind: "approval",
        referenceId: pending.action.id,
        detail: "Write fixture approval",
      },
    });
    await actions.decide({
      id: pending.action.id,
      revision: pending.action.revision,
      hash: pending.action.hash,
      approve: true,
    });
    const waiting = await tasks.find(worker.id);
    assert.ok(waiting);
    const queued = await tasks.resume(waiting.id, waiting.revision, pending.action.id);
    const running = await tasks.claim(queued.id, queued.revision);
    return { id: running.id, revision: running.revision, generation: running.generation };
  });
  credential = await issue();
  const prepared = await database.transaction(ownerId, ({ deviceFileWrites }) =>
    deviceFileWrites.prepare(credential, request),
  );
  assert.ok(prepared && prepared.action.state === "approved");
  assert.equal(prepared.action.id, pending.action.id);
  const operation = deviceOperationSchema.parse(prepared.action.request.arguments);
  assert.equal(operation.kind, "file.write");
  assert.deepEqual(operation, before);
  const message: DeviceMessage = {
    version: 1,
    ...session,
    messageId: randomUUID(),
    correlationId: randomUUID(),
    payload: {
      kind: "execute",
      executionId: prepared.action.operationId,
      taskId: worker.id,
      taskRevision: worker.revision,
      deadline: Date.now() + 60_000,
      operation,
    },
  };
  const reserve = () =>
    database.transaction(ownerId, ({ deviceExecutions }) =>
      deviceExecutions.reserveApproved({
        id: prepared.action.id,
        hash: prepared.action.hash,
        task: worker,
        message,
      }),
    );
  const authority = {
    session,
    executionId: prepared.action.operationId,
    transferId: operation.transferId,
    operation: "file.write" as const,
  };
  const access = () =>
    database.transaction(ownerId, ({ deviceFileWrites }) =>
      deviceFileWrites.authorize(session.deviceId, authority),
    );
  const anotherArtifact = async () => {
    const publish = createWorkspaceFilePublisher({ database, artifacts });
    const result = await publish(
      credential,
      {
        version: 1,
        key: "second-source",
        name: "different.txt",
        mediaType: "text/plain",
        size: content.length,
        sha256,
      },
      [content],
      new AbortController().signal,
    );
    assert.equal(result.status, "ok");
    assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
    const id = artifactSchema.shape.id.parse(result.data.artifactId);
    const other = await database.transaction(ownerId, ({ artifacts: records }) => records.find(id));
    assert.ok(other && other.state === "ready");
    return other;
  };
  return {
    ownerId,
    workspaceId,
    worker,
    session,
    credential,
    artifact,
    request,
    prepared,
    operation,
    message,
    reserve,
    access,
    authority,
    anotherArtifact,
  };
}
