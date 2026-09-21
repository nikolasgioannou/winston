import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import { readAuthConfig } from "../src/auth-config";
import { createApi, type HttpEnvironment } from "../src/http/app";

test("auth configuration fails closed and never echoes secret values", () => {
  assert.throws(
    () => readAuthConfig({ GOOGLE_CLIENT_SECRET: "private-value" }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("OWNER_EMAIL"));
      assert.ok(!error.message.includes("private-value"));

      return true;
    },
  );
});

test("owner mutations require the configured origin even with a valid session", async () => {
  const router = new Hono<HttpEnvironment>();
  router.post("/example", (context) => context.json({ success: true }));
  const options = {
    groups: {
      owner: {
        router,
        authenticate: () => Promise.resolve({ kind: "owner" as const, ownerId: "fixture" }),
      },
    },
  };
  const { app } = createApi({ ...options, ownerOrigin: "http://127.0.0.1:5173" });

  assert.equal((await app.request("/api/owner/example", { method: "POST" })).status, 403);
  assert.equal(
    (
      await app.request("/api/owner/example", {
        method: "POST",
        headers: { Origin: "https://other.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("/api/owner/example", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:5173" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await createApi(options).app.request("/api/owner/example", { method: "POST" })).status,
    403,
  );
});
