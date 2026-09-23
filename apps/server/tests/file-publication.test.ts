import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import { createApi } from "../src/http/app";
import { createCliTaskGroup } from "../src/http/cli";

test("binary file publication authenticates separately and preserves ordinary JSON limits", async () => {
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  const taskId = randomUUID();
  const token = `wst_${"c".repeat(43)}`;
  const content = Buffer.alloc(2 * 1024 * 1024, 42);
  const metadata = {
    version: 1,
    key: "fixture",
    name: "fixture.bin",
    mediaType: "application/octet-stream",
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  let calls = 0;
  const database = {
    authenticateService: (credential: ServiceRequest) =>
      Promise.resolve(
        credential.token === token &&
          credential.operation === "gateway:control" &&
          credential.subjectId === workspaceId
          ? {
              ...credential,
              ownerId,
              taskId,
              revision: 1,
              generation: 1,
              credential: null,
              capabilityId: randomUUID(),
            }
          : null,
      ),
    transaction: <Result>(): Promise<Result> => {
      throw new Error("Unexpected transaction");
    },
  };
  const { app } = createApi({
    groups: {
      task: createCliTaskGroup(database, undefined, async (_credential, input, source) => {
        calls += 1;
        if (input.key === "cached")
          return { version: 1, status: "ok", data: { artifactId: randomUUID() } };
        let size = 0;
        for await (const chunk of source) size += chunk.byteLength;
        assert.equal(size, input.size);
        return { version: 1, status: "ok", data: { artifactId: randomUUID() } };
      }),
    },
  });
  const request = (
    value: unknown = metadata,
    body = content,
    bearer = token,
    path = "/api/tasks/files/publish",
  ) =>
    app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Winston-Workspace": workspaceId,
        "Content-Type": "application/octet-stream",
        "X-Winston-File": Buffer.from(JSON.stringify(value)).toString("base64url"),
      },
      body,
    });
  assert.equal((await request()).status, 200);
  assert.equal(calls, 1);
  assert.equal((await request(metadata, content, "bad")).status, 401);
  assert.equal(calls, 1);
  assert.equal((await request({ ...metadata, size: 50 * 1024 * 1024 + 1 })).status, 400);
  assert.equal((await request({ ...metadata, ownerId })).status, 400);
  assert.equal(calls, 1);
  assert.equal((await request(metadata, content, token, "/api/tasks/cli/control")).status, 413);
  assert.equal((await request({ ...metadata, size: 1 })).status, 413);
  assert.equal((await request(metadata, Buffer.from("short"))).status, 400);
  let canceled = false;
  const response = await app.request("/api/tasks/files/publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Winston-Workspace": workspaceId,
      "Content-Type": "application/octet-stream",
      "X-Winston-File": Buffer.from(JSON.stringify({ ...metadata, key: "cached" })).toString(
        "base64url",
      ),
    },
    body: new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(canceled, true);
});
