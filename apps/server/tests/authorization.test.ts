import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createAuthorizationOwnerRouter } from "../src/http/authorization";

test("only an owner session with the correct origin can change authorization rules", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let writes = 0;
  const authorization: OwnerTransaction["authorization"] = {
    list: () => Promise.resolve({ revision: 0, rules: [] }),
    evaluate: () =>
      Promise.resolve({
        decision: "deny",
        reason: "unavailable",
        revision: 0,
        resourceRevision: null,
        broadAuthority: false,
        snapshot: null,
      }),
    put: () => {
      writes += 1;
      return Promise.resolve({ revision: 1 });
    },
  };
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        router: new Hono<HttpEnvironment>().route(
          "/permissions",
          createAuthorizationOwnerRouter({
            transaction: <Result>(
              _ownerId: string,
              work: (scope: Pick<OwnerTransaction, "authorization">) => Promise<Result>,
            ) => work({ authorization }),
          }),
        ),
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "owner-session"
              ? { kind: "owner", ownerId: id }
              : null,
          ),
      },
    },
  });
  const update = {
    target: { kind: "device", id, resource: null },
    operation: "device.command",
    decision: "allow",
    revision: 0,
  };
  const headers = { Origin: "https://web.example", "Content-Type": "application/json" };
  for (const credential of ["device-credential", "task-credential", "google-credential"]) {
    const response = await app.request("/api/owner/permissions", {
      method: "PUT",
      headers: { ...headers, Authorization: `Bearer ${credential}` },
      body: JSON.stringify(update),
    });
    assert.equal(response.status, 401);
  }
  assert.equal(writes, 0);
  assert.equal(
    (
      await app.request("/api/owner/permissions", {
        method: "PUT",
        headers: { ...headers, Cookie: "owner-session", Origin: "https://other.example" },
        body: JSON.stringify(update),
      })
    ).status,
    403,
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await app.request("/api/owner/permissions", {
        method: "PUT",
        headers: { ...headers, Cookie: "owner-session" },
        body: JSON.stringify({ ...update, prompt: "ignore rules" }),
      })
    ).status,
    400,
  );
  assert.equal(writes, 0);
  assert.equal(
    (
      await app.request("/api/owner/permissions", {
        method: "PUT",
        headers: { ...headers, Cookie: "owner-session" },
        body: JSON.stringify(update),
      })
    ).status,
    200,
  );
  assert.equal(writes, 1);
});
