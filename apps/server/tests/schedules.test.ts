import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { ScheduleWriteError } from "@winston/adapters/database";
import { ScheduleEvaluationError } from "@winston/adapters/schedules";
import type { Schedule } from "@winston/contracts/schedules";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createScheduleOwnerRouter } from "../src/http/schedules";

test("schedule management checks sessions, origins, revisions and owner provenance", async () => {
  const ownerId = randomUUID();
  const sourceId = randomUUID();
  const current: Schedule = {
    id: randomUUID(),
    ownerId,
    revision: 2,
    state: "active",
    objective: "Water the plants",
    sourceMessageIds: [sourceId],
    timing: { kind: "once", startAt: "2027-01-01T14:00:00.000Z", timezone: "UTC" },
    nextRunAt: "2027-01-01T14:00:00.000Z",
  };
  let calls = 0;
  let invalidTiming = false;
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/schedules",
          createScheduleOwnerRouter({
            transaction(owner, work) {
              assert.equal(owner, ownerId);
              calls++;
              return work({
                schedules: {
                  sources: (id) => {
                    if (id !== current.id) throw new ScheduleWriteError("not_found");
                    return Promise.resolve({ id, revision: current.revision, items: [] });
                  },
                  runs: (id, before) => {
                    if (id !== current.id) throw new ScheduleWriteError("not_found");
                    if (before)
                      assert.deepEqual(before, { revision: 2, dueAt: current.timing.startAt });
                    return Promise.resolve({ items: [], next: null });
                  },
                  find: (id) => Promise.resolve(id === current.id ? current : undefined),
                  findByKey: () => Promise.resolve(undefined),
                  list: () => Promise.resolve([current]),
                  create: (input) => {
                    assert.equal(input.key, "web:fixture");
                    assert.deepEqual(input.sourceMessageIds, []);
                    if (invalidTiming) throw new ScheduleEvaluationError();
                    return Promise.resolve(current);
                  },
                  update: (id, revision, input) => {
                    assert.equal(id, current.id);
                    assert.deepEqual(input.sourceMessageIds, [sourceId]);
                    if (revision !== current.revision) throw new ScheduleWriteError("conflict");
                    return Promise.resolve({ ...current, ...input, revision: revision + 1 });
                  },
                  cancel: (id, revision) => {
                    if (id !== current.id) throw new ScheduleWriteError("not_found");
                    if (revision !== current.revision) throw new ScheduleWriteError("conflict");
                    return Promise.resolve({ ...current, state: "canceled", nextRunAt: null });
                  },
                  claimDue: () => Promise.resolve(undefined),
                  pause: (id, revision) => {
                    assert.equal(id, current.id);
                    assert.equal(revision, current.revision);
                    return Promise.resolve({ ...current, state: "paused", nextRunAt: null });
                  },
                  resume: (id, revision) => {
                    assert.equal(id, current.id);
                    assert.equal(revision, current.revision);
                    return Promise.resolve(current);
                  },
                },
              });
            },
          }),
        ),
      },
    },
  });
  const path = "/api/owner/schedules";
  const headers = {
    Cookie: "session",
    Origin: "https://web.example",
    "Content-Type": "application/json",
  };
  const input = { key: "fixture", objective: current.objective, timing: current.timing };
  const mutate = (suffix: string, method: string, body: unknown, origin = headers.Origin) =>
    app.request(`${path}${suffix}`, {
      method,
      headers: { ...headers, Origin: origin },
      body: JSON.stringify(body),
    });
  assert.equal((await app.request(path)).status, 401);
  assert.equal((await app.request(`${path}/${current.id}/runs`)).status, 401);
  assert.equal((await app.request(`${path}/${current.id}/sources`)).status, 401);
  assert.equal((await mutate("", "POST", input, "https://other.example")).status, 403);
  assert.equal(calls, 0);
  const list = await app.request(path, { headers });
  assert.equal(list.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await list.json(), { items: [current], next: null });
  assert.equal((await app.request(`${path}?after=invalid`, { headers })).status, 400);
  assert.equal((await app.request(`${path}/${randomUUID()}`, { headers })).status, 404);
  const runs = await app.request(`${path}/${current.id}/runs`, { headers });
  const sources = await app.request(`${path}/${current.id}/sources`, { headers });
  assert.equal(sources.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await sources.json(), { id: current.id, revision: 2, items: [] });
  assert.equal((await app.request(`${path}/${randomUUID()}/sources`, { headers })).status, 404);
  assert.equal(runs.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await runs.json(), { items: [], next: null });
  assert.equal((await app.request(`${path}/${randomUUID()}/runs`, { headers })).status, 404);
  const cursor = new URLSearchParams({ beforeRevision: "2", beforeDueAt: current.timing.startAt });
  assert.equal(
    (await app.request(`${path}/${current.id}/runs?${cursor.toString()}`, { headers })).status,
    200,
  );
  for (const query of [
    "beforeRevision=2",
    "beforeDueAt=2027-01-01T00:00:00Z",
    "beforeRevision=-1&beforeDueAt=2027-01-01T00:00:00Z",
    "beforeRevision=2147483648&beforeDueAt=2027-01-01T00:00:00Z",
    "beforeRevision=2&beforeDueAt=bad",
  ]) {
    assert.equal(
      (await app.request(`${path}/${current.id}/runs?${query}`, { headers })).status,
      400,
    );
  }
  assert.equal((await mutate("", "POST", input)).status, 200);
  assert.equal(
    (await mutate("", "POST", { ...input, sourceMessageIds: [randomUUID()] })).status,
    400,
  );
  invalidTiming = true;
  assert.equal((await mutate("", "POST", input)).status, 400);
  const update = { objective: "Changed", timing: current.timing, revision: 2 };
  assert.equal((await mutate(`/${current.id}`, "PUT", update)).status, 200);
  assert.equal((await mutate(`/${current.id}`, "PUT", { ...update, revision: 1 })).status, 409);
  assert.equal((await mutate(`/${randomUUID()}`, "PUT", update)).status, 404);
  assert.equal((await mutate(`/${current.id}/cancel`, "POST", { revision: 1 })).status, 409);
  assert.equal((await mutate(`/${randomUUID()}/cancel`, "POST", { revision: 2 })).status, 404);
  assert.equal((await mutate(`/${current.id}/cancel`, "POST", { revision: 2 })).status, 200);
  assert.equal((await mutate(`/${current.id}/pause`, "POST", { revision: 2 })).status, 200);
  assert.equal((await mutate(`/${current.id}/resume`, "POST", { revision: 2 })).status, 200);
});
