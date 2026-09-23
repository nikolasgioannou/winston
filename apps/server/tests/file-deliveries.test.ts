import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createFileDeliveryOwnerRouter } from "../src/http/file-deliveries";

test("delivery downloads require a current owner session and never cache signed URLs", async () => {
  const ownerId = randomUUID();
  const id = randomUUID();
  let calls = 0;
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "owner-session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/file-deliveries",
          createFileDeliveryOwnerRouter({
            inspect: () => Promise.resolve({ kind: "expired" }),
            download(owner, requested) {
              assert.equal(owner, ownerId);
              assert.equal(requested, id);
              calls++;
              return Promise.resolve({
                url: "https://storage.invalid/signed",
                name: "fixture.txt",
                expiresIn: 60,
              });
            },
          }),
        ),
      },
    },
  });
  const path = `/api/owner/file-deliveries/${id}`;
  assert.equal((await app.request(`${path}/download`)).status, 401);
  assert.equal(
    (await app.request(`${path}/download`, { headers: { Authorization: "Bearer worker" } })).status,
    401,
  );
  assert.equal(calls, 0);
  const headers = { Cookie: "owner-session" };
  const response = await app.request(`${path}/download`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(calls, 1);
  assert.deepEqual(await (await app.request(path, { headers })).json(), { kind: "expired" });
  assert.equal(
    (await app.request("/api/owner/file-deliveries/invalid/download", { headers })).status,
    404,
  );
  assert.equal(calls, 1);
});
