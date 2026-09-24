import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createActivityOwnerRouter } from "../src/http/activity";

test("activity requires an owner session and validates complete precise cursors", async () => {
  const ownerId = randomUUID();
  const cursor = { createdAt: "2026-01-01T00:00:00.000123Z", id: randomUUID() };
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
          "/activity",
          createActivityOwnerRouter({
            transaction(owner, work) {
              assert.equal(owner, ownerId);
              return work({
                tasks: {
                  detail: () => Promise.resolve(null),
                  activityHistory: () => Promise.resolve({ items: [], next: null }),
                  activity: (before) => {
                    calls++;
                    if (before) assert.deepEqual(before, cursor);
                    return Promise.resolve({ items: [], next: null });
                  },
                },
              });
            },
          }),
        ),
      },
    },
  });
  const path = "/api/owner/activity";
  const headers = { Cookie: "session", Origin: "https://web.example" };
  assert.equal((await app.request(path)).status, 401);
  for (const query of [
    "beforeId=bad",
    `beforeId=${cursor.id}`,
    `beforeCreatedAt=${cursor.createdAt}`,
    `beforeId=${cursor.id}&beforeCreatedAt=2026-01-01T00:00:00.000Z`,
  ]) {
    assert.equal((await app.request(`${path}?${query}`, { headers })).status, 400);
  }
  assert.equal(calls, 0);
  const response = await app.request(path, { headers });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { items: [], next: null });
  const query = new URLSearchParams({ beforeCreatedAt: cursor.createdAt, beforeId: cursor.id });
  assert.equal((await app.request(`${path}?${query.toString()}`, { headers })).status, 200);
  assert.equal((await app.request(path, { method: "POST", headers })).status, 404);
  assert.equal(calls, 2);
});

test("task details and history require owner access and reject malformed cursors", async () => {
  const ownerId = randomUUID();
  const id = randomUUID();
  const detail = {
    id,
    revision: 0,
    state: "queued" as const,
    objective: "Request",
    result: null,
    waiting: null,
    createdAt: "2030-01-01T00:00:00.000000Z",
    updatedAt: "2030-01-01T00:00:00.000000Z",
  };
  const cursors: (number | undefined)[] = [];
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/activity",
          createActivityOwnerRouter({
            transaction(owner, work) {
              assert.equal(owner, ownerId);
              return work({
                tasks: {
                  activity: () => Promise.resolve({ items: [], next: null }),
                  detail: (requested) => Promise.resolve(requested === id ? detail : null),
                  activityHistory: (requested, before) => {
                    assert.equal(requested, id);
                    cursors.push(before);
                    return Promise.resolve({ items: [], next: null });
                  },
                },
              });
            },
          }),
        ),
      },
    },
  });
  const headers = { Cookie: "session" };
  const path = `/api/owner/activity/${id}`;
  assert.equal((await app.request(path)).status, 401);
  assert.equal((await app.request(`${path}/history`)).status, 401);
  const response = await app.request(path, { headers });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), detail);
  for (const suffix of ["", "/history"]) {
    assert.equal(
      (await app.request(`/api/owner/activity/${randomUUID()}${suffix}`, { headers })).status,
      404,
    );
    assert.equal((await app.request(`/api/owner/activity/bad${suffix}`, { headers })).status, 404);
  }
  for (const cursor of ["-1", "01", "1.5", "2147483648", "", "NaN"]) {
    assert.equal(
      (await app.request(`${path}/history?beforeRevision=${cursor}`, { headers })).status,
      400,
    );
  }
  assert.equal((await app.request(`${path}/history`, { headers })).status, 200);
  assert.equal((await app.request(`${path}/history?beforeRevision=0`, { headers })).status, 200);
  assert.deepEqual(cursors, [undefined, 0]);
});
