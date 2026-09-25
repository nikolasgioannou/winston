import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import type { DeviceFileUpload } from "@winston/contracts/artifacts";
import { createApi } from "../src/http/app";
import { createDeviceGroup } from "../src/http/devices";

test("native binary uploads bind authenticated device identity and keep other routes size-limited", async () => {
  const ownerId = randomUUID();
  const deviceId = randomUUID();
  const token = `wdi_${"f".repeat(43)}`;
  const cachedExecutionId = randomUUID();
  const artifactId = randomUUID();
  const content = Buffer.alloc(2 * 1024 * 1024, 42);
  const metadata: DeviceFileUpload = {
    version: 1,
    authority: {
      session: { deviceId, sessionId: randomUUID(), generation: 1 },
      executionId: randomUUID(),
      transferId: randomUUID(),
      operation: "file.read",
    },
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  let calls = 0;
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
      device: createDeviceGroup(database, async (owner, device, input, source) => {
        calls += 1;
        assert.equal(owner, ownerId);
        assert.equal(device, deviceId);
        if (input.authority.executionId !== cachedExecutionId) {
          try {
            let size = 0;
            for await (const chunk of source) size += chunk.byteLength;
            assert.equal(size, input.size);
          } catch {
            // A storage adapter may absorb source errors. The HTTP boundary must still
            // retain its own bounded-body failure rather than report success.
            return { version: 1, status: "unknown", transferId: input.authority.transferId };
          }
        }
        return {
          version: 1,
          status: "ready",
          artifactId,
          revision: 1,
          transferId: input.authority.transferId,
          size: input.size,
          sha256: input.sha256,
        };
      }),
    },
  });
  const headers = (value: unknown, bearer = token) => ({
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/octet-stream",
    "X-Winston-File": Buffer.from(JSON.stringify(value)).toString("base64url"),
  });
  const request = (
    value: unknown = metadata,
    body = content,
    bearer = token,
    path = "/api/devices/files/upload",
  ) => app.request(path, { method: "POST", headers: headers(value, bearer), body });
  assert.equal((await request()).status, 200);
  assert.equal(calls, 1);
  assert.equal((await request(metadata, content, "wrong")).status, 401);
  assert.equal(calls, 1);
  assert.equal((await request({ ...metadata, ownerId })).status, 400);
  assert.equal((await request({ ...metadata, source: { path: "/other" } })).status, 400);
  assert.equal((await request({ ...metadata, size: 50 * 1024 * 1024 + 1 })).status, 400);
  assert.equal(
    (await request({ ...metadata, authority: { ...metadata.authority, operation: "file.write" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request({
        ...metadata,
        authority: {
          ...metadata.authority,
          session: { ...metadata.authority.session, deviceId: randomUUID() },
        },
      })
    ).status,
    403,
  );
  assert.equal(calls, 1);
  assert.equal((await request({ ...metadata, size: 1 })).status, 413);
  assert.equal((await request(metadata, Buffer.from("short"))).status, 400);
  assert.equal((await request(metadata, content, token, "/api/devices/self")).status, 413);
  assert.equal(
    (await request(metadata, content, token, "/api/devices/files/upload/other")).status,
    413,
  );
  assert.equal(
    (
      await app.request("/api/devices/files/upload", {
        method: "POST",
        headers: { ...headers(metadata), "Content-Length": "1" },
        body: content,
      })
    ).status,
    400,
  );
  let canceled = false;
  const response = await app.request("/api/devices/files/upload", {
    method: "POST",
    headers: headers({
      ...metadata,
      authority: { ...metadata.authority, executionId: cachedExecutionId },
    }),
    body: new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(canceled, true);
});
