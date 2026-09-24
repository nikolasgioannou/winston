import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createWorkspaceOwnerRouter } from "../src/http/workspace-catalog";

test("owner workspace catalog is authenticated, read-only and validates its cursor", async () => {
  const ownerId = randomUUID();
  const id = randomUUID();
  const item = { id, name: "Winston", state: "active" as const, revision: 1 };
  let calls = 0;
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/workspaces",
          createWorkspaceOwnerRouter({
            transaction(owner, work) {
              assert.equal(owner, ownerId);
              calls++;
              return work({
                workspaces: {
                  list: (after) => {
                    assert.ok(after === undefined || after === id);
                    return Promise.resolve({ items: after ? [] : [item], next: null });
                  },
                },
              });
            },
          }),
        ),
      },
    },
  });
  const path = "/api/owner/workspaces";
  assert.equal((await app.request(path)).status, 401);
  const headers = { Cookie: "session", Origin: "https://web.example" };
  assert.equal((await app.request(`${path}?after=bad`, { headers })).status, 400);
  assert.equal(calls, 0);
  const response = await app.request(path, { headers });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { items: [item], next: null });
  assert.deepEqual(await (await app.request(`${path}?after=${id}`, { headers })).json(), {
    items: [],
    next: null,
  });
  assert.equal((await app.request(path, { method: "POST", headers })).status, 404);
  assert.equal(calls, 2);
});
