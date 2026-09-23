import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { publishFile } from "../src/file-gateway";
import { parseCommand } from "../src/parse";

test("file publication sends binary content only to the fixed control gateway", async () => {
  const bytes = Buffer.from("fixture");
  const metadata = {
    version: 1 as const,
    key: "fixture",
    name: "fixture.txt",
    mediaType: "text/plain",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const authority = {
    version: 1 as const,
    environment: "production" as const,
    workspaceId: randomUUID(),
    token: `wst_${"a".repeat(43)}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const controlToken = `wst_${"b".repeat(43)}`;
  let calls = 0;
  const send = (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(url, "https://winston-628.fly.dev/api/tasks/files/publish");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${controlToken}`);
    assert.equal(headers.get("Content-Type"), "application/octet-stream");
    assert.deepEqual(
      JSON.parse(Buffer.from(headers.get("X-Winston-File") ?? "", "base64url").toString()),
      metadata,
    );
    assert.deepEqual(init.body, bytes);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    return Promise.resolve(
      Response.json({ version: 1, status: "ok", data: { artifactId: randomUUID() } }),
    );
  };
  assert.equal((await publishFile(authority, metadata, bytes, send)).status, "denied");
  assert.equal(calls, 0);
  assert.equal(
    (await publishFile({ ...authority, controlToken }, metadata, bytes, send)).status,
    "ok",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    publishFile({ ...authority, controlToken }, metadata, Buffer.from("short"), send),
    /size/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    parseCommand([
      "files",
      "publish",
      "--path",
      "/data/home/artifacts/fixture.txt",
      "--key",
      "fixture",
    ]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "files.publish",
        path: "/data/home/artifacts/fixture.txt",
        key: "fixture",
        mediaType: "application/octet-stream",
      },
    },
  );
  assert.throws(() =>
    parseCommand(["files", "publish", "--path", "/data/home/artifacts/fixture.txt"]),
  );
});
