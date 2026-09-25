import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApi } from "../src/http/app";
import { createFileTransferGroup } from "../src/http/artifact-transfers";

test("artifact credentials authorize only an exact descriptor on their own callback", async () => {
  const transfer = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    workspaceRevision: 1,
    transferId: randomUUID(),
    artifactId: randomUUID(),
    artifactRevision: 2,
    task: { id: randomUUID(), revision: 3, generation: 4 },
    size: 3,
    sha256: "a".repeat(64),
  };
  const token = `wat_${"a".repeat(43)}`;
  let enabled = true;
  const group = createFileTransferGroup({
    authenticateInboxTransfer: () => Promise.resolve(null),
    authenticateArtifactTransfer: (input) =>
      Promise.resolve(enabled && input === token ? transfer : null),
  });
  const { app } = createApi({ groups: { transfer: group } });
  const request = (body = transfer, path = "/api/transfers/artifacts/authorize") =>
    app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await request()).status, 200);
  assert.equal((await request({ ...transfer, ownerId: randomUUID() })).status, 403);
  assert.equal(
    (await request({ ...transfer, task: { ...transfer.task, generation: 5 } })).status,
    403,
  );
  assert.equal((await request({ ...transfer, artifactRevision: 3 })).status, 403);
  for (const path of [
    "/api/tasks/cli/control",
    "/api/transfers/inbox/authorize",
    "/api/transfers/artifacts/complete",
  ])
    assert.equal((await request(transfer, path)).status, 401);
  enabled = false;
  assert.equal((await request()).status, 401);
});
