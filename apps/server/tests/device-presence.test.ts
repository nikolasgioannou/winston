import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createDevicePresenceRouter } from "../src/http/device-presence";

test("computer presence requires owner authentication and returns only scoped public fields", async () => {
  const ownerId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const presence = [{ deviceId, status: "unreachable" as const, lastSeenAt: null }];
  let calls = 0;
  const { app } = createApi({
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/devices/presence",
          createDevicePresenceRouter({
            transaction(id, work) {
              assert.equal(id, ownerId);
              calls += 1;
              return work({ deviceSessions: { presence: () => Promise.resolve(presence) } });
            },
          }),
        ),
      },
    },
  });
  const path = "/api/owner/devices/presence";
  assert.equal((await app.request(path)).status, 401);
  assert.equal(
    (await app.request(path, { headers: { Authorization: `Bearer wdi_${"a".repeat(43)}` } }))
      .status,
    401,
  );
  assert.equal(calls, 0);
  const response = await app.request(path, { headers: { Cookie: "session" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), presence);
  assert.equal(calls, 1);
});
