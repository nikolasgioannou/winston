import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { createApi, type HttpEnvironment, type RequestLog } from "../src/http/app";
import {
  authenticateDevicePairing,
  createDeviceGroup,
  createDeviceOwnerRouter,
  createDevicePairingRouter,
} from "../src/http/devices";

test("device credentials cannot act as owner sessions and pairing validates before consumption", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const secret = `wdp_${"a".repeat(43)}`;
  const credential = `wdi_${"b".repeat(43)}`;
  const registration = {
    platform: "macos" as const,
    appVersion: "0.1.0",
    protocolVersion: 1 as const,
    capabilities: [],
  };
  const device = {
    ...registration,
    id,
    name: "MacBook",
    revision: 0,
    isDefault: false,
    revoked: false,
    createdAt: "2026-09-22T12:00:00.000Z",
  };
  let consumed = false;
  let starts = 0;
  const devices: OwnerTransaction["devices"] = {
    find: () => Promise.resolve(device),
    list: () => Promise.resolve([device]),
    start: () => {
      starts += 1;
      return Promise.resolve({ id, secret, expiresAt: "2026-09-22T12:05:00.000Z" });
    },
    cancelPairing: () => Promise.resolve(),
    pair: () => {
      consumed = true;
      return Promise.resolve({ device, credential });
    },
    rename: () => Promise.resolve(null),
    setDefault: () => Promise.resolve(null),
    revoke: () => Promise.resolve(null),
  };
  const database = {
    transaction: <Result>(
      _ownerId: string,
      work: (scope: Pick<OwnerTransaction, "devices">) => Promise<Result>,
    ) => work({ devices }),
    authenticateDevice: (token: string) =>
      Promise.resolve(token === credential ? { ownerId: id, deviceId: id } : null),
    authenticateDevicePairing: (token: string) =>
      Promise.resolve(token === secret && !consumed ? { ownerId: id } : null),
  };
  const logs: RequestLog[] = [];
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    log: (entry) => {
      logs.push(entry);
    },
    groups: {
      owner: {
        router: new Hono<HttpEnvironment>().route("/devices", createDeviceOwnerRouter(database)),
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "owner-session"
              ? { kind: "owner", ownerId: id }
              : null,
          ),
      },
      device: createDeviceGroup(database),
      callback: {
        router: createDevicePairingRouter(database),
        authenticate: (request) => authenticateDevicePairing(database, request),
      },
    },
  });
  assert.equal(
    (
      await app.request("/api/owner/devices", {
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (await app.request("/api/devices/self", { headers: { Cookie: "owner-session" } })).status,
    401,
  );
  assert.equal(
    (await app.request("/api/devices/self", { headers: { Authorization: `Bearer ${secret}` } }))
      .status,
    401,
  );
  assert.equal(
    (await app.request("/api/devices/self", { headers: { Authorization: `Bearer ${credential}` } }))
      .status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/devices/other", {
        headers: { Authorization: `Bearer ${credential}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await app.request("/api/owner/devices/pairing", {
        method: "POST",
        headers: { Cookie: "owner-session", "Content-Type": "application/json" },
        body: '{"name":"MacBook"}',
      })
    ).status,
    403,
  );
  assert.equal(starts, 0);
  assert.equal(
    (
      await app.request("/api/owner/devices/pairing", {
        method: "POST",
        headers: {
          Cookie: "owner-session",
          Origin: "https://web.example",
          "Content-Type": "application/json",
        },
        body: '{"name":"MacBook"}',
      })
    ).status,
    200,
  );
  assert.equal(starts, 1);
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  assert.equal(
    (
      await app.request("/callbacks/devices/pair", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...registration, ownerId: id }),
      })
    ).status,
    400,
  );
  assert.equal(consumed, false);
  const paired = await app.request("/callbacks/devices/pair", {
    method: "POST",
    headers,
    body: JSON.stringify(registration),
  });
  assert.equal(paired.status, 201);
  assert.equal(paired.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await paired.json(), { device, credential });
  assert.equal(
    (
      await app.request("/callbacks/devices/pair", {
        method: "POST",
        headers,
        body: JSON.stringify(registration),
      })
    ).status,
    401,
  );
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(logs).includes(credential));
});
