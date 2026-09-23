import assert from "node:assert/strict";
import { test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createApi } from "../src/http/app";
import { createInboxTransferGroup } from "../src/http/inbox-transfers";

test("inbox authority is separate from task and owner routes and matches the exact transfer", async () => {
  const transfer = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    intakeId: randomUUID(),
    workspaceRevision: 1,
    artifactId: randomUUID(),
    size: 3,
    sha256: "a".repeat(64),
  };
  const token = `wit_${"a".repeat(43)}`;
  let enabled = true;
  const group = createInboxTransferGroup({
    authenticateInboxTransfer: (input) =>
      Promise.resolve(enabled && input === token ? transfer : null),
  });
  const { app } = createApi({ groups: { transfer: group } });
  const request = (body = transfer, path = "/api/transfers/inbox/authorize") =>
    app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await request()).status, 200);
  assert.equal((await request({ ...transfer, artifactId: randomUUID() })).status, 403);
  assert.equal((await request(transfer, "/api/tasks/execute")).status, 401);
  assert.equal((await request(transfer, "/api/transfers/inbox/complete")).status, 401);
  enabled = false;
  assert.equal((await request()).status, 401);
});
