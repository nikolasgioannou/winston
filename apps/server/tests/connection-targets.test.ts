import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import type { OwnerTransaction } from "@winston/adapters/database";
import { createApi, type HttpEnvironment } from "../src/http/app";
import { createTargetPreferencesRouter } from "../src/http/connection-targets";

test("target preferences require an owner session and reject stale updates", async () => {
  let writes = 0;
  const connectionTargets: OwnerTransaction["connectionTargets"] = {
    preferences: () => Promise.resolve({ revision: 1, labels: [], defaults: [] }),
    currentTask: () => Promise.resolve(true),
    binding: () => Promise.resolve(undefined),
    bind: () => Promise.resolve(),
    put: (input) => {
      writes += 1;
      return Promise.resolve(input.revision === 1 ? { ...input, revision: 2 } : null);
    },
  };
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    groups: {
      owner: {
        router: new Hono<HttpEnvironment>().route(
          "/connection-targets",
          createTargetPreferencesRouter({
            transaction: <T>(
              _owner: string,
              work: (scope: Pick<OwnerTransaction, "connectionTargets">) => Promise<T>,
            ) => work({ connectionTargets }),
          }),
        ),
        authenticate: (request) =>
          Promise.resolve(
            request.headers.get("Cookie") === "owner-session"
              ? { kind: "owner", ownerId: "11111111-1111-4111-8111-111111111111" }
              : null,
          ),
      },
    },
  });
  const input = { revision: 1, labels: [], defaults: [] };
  const headers = { Origin: "https://web.example", "Content-Type": "application/json" };
  const request = (extra: Record<string, string>, value: unknown = input) =>
    app.request("/api/owner/connection-targets", {
      method: "PUT",
      headers: { ...headers, ...extra },
      body: JSON.stringify(value),
    });
  assert.equal((await request({ Authorization: "Bearer device-credential" })).status, 401);
  assert.equal(
    (await request({ Cookie: "owner-session", Origin: "https://other.example" })).status,
    403,
  );
  assert.equal(
    (await request({ Cookie: "owner-session" }, { ...input, instruction: "pick me" })).status,
    400,
  );
  assert.equal(writes, 0);
  assert.equal((await request({ Cookie: "owner-session" }, { ...input, revision: 0 })).status, 409);
  assert.equal((await request({ Cookie: "owner-session" })).status, 200);
  assert.equal(writes, 2);
});
