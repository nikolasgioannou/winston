import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createActivityOwnerRouter } from "../src/http/activity";
import { TaskWriteError } from "@winston/adapters/database";

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
                  actionEvidence: () => Promise.resolve({ unresolved: 0, items: [], next: null }),
                  cancel: () => Promise.reject(new TaskWriteError("not_found", "Missing")),
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
  let canceled = 0;
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
                  actionEvidence: (requested) => {
                    assert.equal(requested, id);
                    return Promise.resolve({ unresolved: 2, items: [], next: null });
                  },
                  cancel: (requested, revision) => {
                    if (requested !== id)
                      return Promise.reject(new TaskWriteError("not_found", "Missing"));
                    if (revision !== 0)
                      return Promise.reject(new TaskWriteError("conflict", "Changed"));
                    canceled++;
                    return Promise.resolve({
                      ...detail,
                      ownerId,
                      generation: 1,
                      sourceMessageIds: [],
                      blocker: null,
                      state: "canceled" as const,
                    });
                  },
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
  assert.equal((await app.request(`${path}/actions`)).status, 401);
  assert.equal((await app.request(`${path}/actions?after=bad`, { headers })).status, 400);
  assert.equal(
    (await app.request(`/api/owner/activity/${randomUUID()}/actions`, { headers })).status,
    404,
  );
  assert.deepEqual(await (await app.request(`${path}/actions`, { headers })).json(), {
    unresolved: 2,
    items: [],
    next: null,
  });
  const write = (revision: number, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", ...extra },
    body: JSON.stringify({ revision }),
  });
  assert.equal(
    (await app.request(`${path}/cancel`, write(0, { Origin: "https://wrong.example" }))).status,
    403,
  );
  assert.equal(canceled, 0);
  assert.equal(
    (await app.request(`${path}/cancel`, write(1, { Origin: "https://web.example" }))).status,
    409,
  );
  assert.equal(
    (
      await app.request(
        `/api/owner/activity/${randomUUID()}/cancel`,
        write(0, { Origin: "https://web.example" }),
      )
    ).status,
    404,
  );
  assert.equal(
    (await app.request(`${path}/cancel`, write(-1, { Origin: "https://web.example" }))).status,
    400,
  );
  assert.equal(
    (await app.request(`${path}/cancel`, write(0, { Origin: "https://web.example" }))).status,
    200,
  );
  assert.equal(canceled, 1);
});
