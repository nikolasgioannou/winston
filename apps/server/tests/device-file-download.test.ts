import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createApi } from "../src/http/app";
import { createDeviceGroup } from "../src/http/devices";

test("native downloads authenticate the paired device and accept only exact write proof", async () => {
  const ownerId = randomUUID();
  const deviceId = randomUUID();
  const token = `wdi_${"d".repeat(43)}`;
  const input = {
    version: 1,
    authority: {
      session: { deviceId, sessionId: randomUUID(), generation: 1 },
      executionId: randomUUID(),
      transferId: randomUUID(),
      operation: "file.write",
    },
  };
  const content = Buffer.from("fixture");
  const source = {
    artifactId: randomUUID(),
    revision: 2,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  let calls = 0;
  let allowed = true;
  const database = {
    authenticateDevice: (credential: string) =>
      Promise.resolve(credential === token ? { ownerId, deviceId } : null),
    authenticateDevicePairing: () => Promise.resolve(null),
    transaction: <Result>(): Promise<Result> => {
      throw new Error("Unexpected transaction");
    },
  };
  const { app } = createApi({
    groups: {
      device: createDeviceGroup(database, undefined, (owner, device, proof, signal) => {
        calls += 1;
        assert.equal(owner, ownerId);
        assert.equal(device, deviceId);
        assert.deepEqual(proof, input);
        assert.ok(signal instanceof AbortSignal);
        return Promise.resolve(
          allowed
            ? {
                source,
                body: new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(content);
                    controller.close();
                  },
                }),
              }
            : null,
        );
      }),
    },
  });
  const request = (body: unknown = input, credential = token) =>
    app.request("/api/devices/files/download", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Length"), String(content.length));
  assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(
    JSON.parse(Buffer.from(response.headers.get("X-Winston-File") ?? "", "base64url").toString()),
    { version: 1, source },
  );
  assert.equal(await response.text(), "fixture");
  assert.equal((await request(input, "wrong")).status, 401);
  assert.equal((await request({ ...input, source })).status, 400);
  assert.equal((await request({ ...input, url: "https://untrusted.example" })).status, 400);
  assert.equal(
    (await request({ ...input, authority: { ...input.authority, operation: "file.read" } })).status,
    400,
  );
  assert.equal(
    (
      await request({
        ...input,
        authority: {
          ...input.authority,
          session: { ...input.authority.session, deviceId: randomUUID() },
        },
      })
    ).status,
    403,
  );
  assert.equal((await request({ ...input, padding: "x".repeat(2 * 1024 * 1024) })).status, 413);
  assert.equal(calls, 1);
  allowed = false;
  assert.equal((await request()).status, 403);
  assert.equal(calls, 2);
});
