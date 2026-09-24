import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { Hono } from "hono";
import { ResponsibilityWriteError } from "@winston/adapters/database";
import type { Responsibility } from "@winston/contracts/responsibilities";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createResponsibilityOwnerRouter } from "../src/http/responsibilities";

test("responsibility endpoints require owner sessions and current explicit agreement", async () => {
  const ownerId = randomUUID();
  const sourceId = randomUUID();
  const current: Responsibility = {
    id: randomUUID(),
    ownerId,
    revision: 3,
    state: "proposed",
    purpose: "Check my trip",
    scope: [],
    sources: [{ messageId: sourceId, revision: 0 }],
    agreement: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let calls = 0;
  let invalidScope = false;
  const check = (id: string, revision: number) => {
    if (id !== current.id) throw new ResponsibilityWriteError("not_found");
    if (revision !== current.revision) throw new ResponsibilityWriteError("conflict");
  };
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "session" ? { kind: "owner", ownerId } : null,
          ),
        router: new Hono<HttpEnvironment>().route(
          "/responsibilities",
          createResponsibilityOwnerRouter({
            transaction(owner, work) {
              assert.equal(owner, ownerId);
              calls++;
              return work({
                responsibilities: {
                  find: (id) => Promise.resolve(id === current.id ? current : undefined),
                  list: () => Promise.resolve([current]),
                  propose: (input) => {
                    assert.equal(input.key, "web:fixture");
                    assert.deepEqual(input.sourceMessageIds, []);
                    if (invalidScope) throw new ResponsibilityWriteError("invalid_scope");
                    return Promise.resolve(current);
                  },
                  revise: (id, revision, input) => {
                    check(id, revision);
                    assert.deepEqual(input.sourceMessageIds, [sourceId]);
                    return Promise.resolve(current);
                  },
                  agree: (id, revision) => {
                    check(id, revision);
                    return Promise.resolve({
                      ...current,
                      state: "active",
                      revision: 4,
                      agreement: { proposalRevision: 3, at: current.updatedAt },
                    });
                  },
                  transition: (id, revision, state) => {
                    check(id, revision);
                    return Promise.resolve({ ...current, revision: 4, state });
                  },
                },
              });
            },
          }),
        ),
      },
    },
  });
  const path = "/api/owner/responsibilities";
  const headers = {
    Cookie: "session",
    Origin: "https://web.example",
    "Content-Type": "application/json",
  };
  const mutate = (suffix: string, body: unknown, method = "POST", origin = headers.Origin) =>
    app.request(`${path}${suffix}`, {
      method,
      headers: { ...headers, Origin: origin },
      body: JSON.stringify(body),
    });
  assert.equal((await app.request(path)).status, 401);
  assert.equal(
    (await mutate(`/${current.id}/agree`, { revision: 3 }, "POST", "https://evil.example")).status,
    403,
  );
  assert.equal(calls, 0);
  const list = await app.request(path, { headers });
  assert.equal(list.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await list.json(), { items: [current], next: null });
  assert.equal((await app.request(`${path}?after=invalid`, { headers })).status, 400);
  assert.equal((await app.request(`${path}/${randomUUID()}`, { headers })).status, 404);
  const proposal = { key: "fixture", purpose: current.purpose, scope: [] };
  assert.equal((await mutate("", proposal)).status, 200);
  for (const injected of [
    { state: "active" },
    { sourceMessageIds: [sourceId] },
    { agreement: { proposalRevision: 3, at: current.updatedAt } },
  ])
    assert.equal((await mutate("", { ...proposal, ...injected })).status, 400);
  invalidScope = true;
  assert.equal((await mutate("", proposal)).status, 400);
  assert.equal(
    (await mutate(`/${current.id}`, { purpose: "Changed", scope: [], revision: 3 }, "PUT")).status,
    200,
  );
  assert.equal(
    (await mutate(`/${current.id}`, { purpose: "Changed", scope: [], revision: 2 }, "PUT")).status,
    409,
  );
  for (const action of ["agree", "pause", "resume", "end"]) {
    assert.equal((await mutate(`/${current.id}/${action}`, { revision: 2 })).status, 409);
    assert.equal((await mutate(`/${randomUUID()}/${action}`, { revision: 3 })).status, 404);
    assert.equal(
      (await mutate(`/${current.id}/${action}`, { revision: 3, ownerId: randomUUID() })).status,
      400,
    );
    assert.equal((await mutate(`/${current.id}/${action}`, { revision: 3 })).status, 200);
  }
});
