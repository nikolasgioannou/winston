import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { readConfig } from "../src/config";
import { startServer } from "../src/host";
import { createApi, type HttpEnvironment, type RequestLog } from "../src/http/app";
import { parseJson } from "../src/http/errors";

test("configuration rejects invalid fields without exposing their values", () => {
  assert.deepEqual(readConfig({}), {
    hostname: "127.0.0.1",
    port: 3001,
    shutdownTimeoutMs: 10_000,
  });
  assert.throws(() => readConfig({ PORT: "secret-value" }), {
    message: "Invalid server configuration: PORT",
  });
});

test("liveness remains distinct from startup and dependency readiness", async () => {
  let available = false;
  const { app, lifecycle } = createApi({ readiness: () => Promise.resolve(available) });

  assert.equal((await app.request("/health/live")).status, 200);
  assert.equal((await app.request("/health/ready")).status, 503);

  lifecycle.started = true;
  assert.equal((await app.request("/health/ready")).status, 503);

  available = true;
  assert.equal((await app.request("/health/ready")).status, 200);

  lifecycle.draining = true;
  assert.equal((await app.request("/health/ready")).status, 503);
});

test("route authorities fail closed, including device WebSocket upgrade requests", async () => {
  const { app } = createApi();

  for (const path of [
    "/callbacks/telegram",
    "/api/owner/profile",
    "/api/tasks/execute",
    "/api/devices/connect",
  ]) {
    const response = await app.request(path, {
      headers: { authorization: "Bearer synthetic", upgrade: "websocket" },
    });

    assert.equal(response.status, 401);
  }

  const router = new Hono<HttpEnvironment>();
  router.get("/profile", (context) => context.json({ allowed: true }));
  const mismatched = createApi({
    groups: {
      owner: {
        router,
        authenticate: () =>
          Promise.resolve({ kind: "device", ownerId: "owner-1", deviceId: "device-1" }),
      },
    },
  });

  assert.equal((await mismatched.app.request("/api/owner/profile")).status, 403);
});

test("a failing dependency probe produces unavailable without exposing its error", async () => {
  const { app, lifecycle } = createApi({
    readiness: () => {
      throw new Error("secret-database-url");
    },
  });
  lifecycle.started = true;

  const response = await app.request("/health/ready");
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("secret-database-url"));
});

test("invalid bodies and internal errors produce safe correlated responses", async () => {
  const router = new Hono<HttpEnvironment>();
  const logs: RequestLog[] = [];

  router.post("/example", async (context) => {
    const body = await parseJson(context, z.object({ name: z.string().max(20) }).strict());

    return context.json(body);
  });
  router.get("/failure", () => {
    throw new Error("secret-provider-token");
  });

  const { app } = createApi({
    ownerOrigin: "http://127.0.0.1:5173",
    groups: {
      owner: { router, authenticate: () => Promise.resolve({ kind: "owner", ownerId: "owner-1" }) },
    },
    log: (entry) => {
      logs.push(entry);
    },
  });

  for (const body of ["{", '{"name":42}', '{"name":"ok","token":"secret-provider-token"}']) {
    const response = await app.request("/api/owner/example?token=secret-provider-token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "untrusted-id",
        origin: "http://127.0.0.1:5173",
      },
      body,
    });

    assert.equal(response.status, 400);
    assert.notEqual(response.headers.get("x-request-id"), "untrusted-id");
    const text = await response.text();
    assert.ok(text.includes(response.headers.get("x-request-id") ?? "missing"));
    assert.ok(!text.includes("secret-provider-token"));
  }

  assert.equal(
    (
      await app.request("/api/owner/example", {
        method: "POST",
        headers: { Origin: "http://127.0.0.1:5173" },
        body: "hello",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await app.request("/api/owner/example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(1_048_577),
      })
    ).status,
    413,
  );

  const failure = await app.request("/api/owner/failure");
  assert.equal(failure.status, 500);
  assert.ok(!(await failure.text()).includes("secret-provider-token"));
  assert.ok(!JSON.stringify(logs).includes("secret-provider-token"));
  assert.equal(logs.at(-1)?.status, 500);

  const valid = await app.request("/api/owner/example", {
    method: "POST",
    headers: { "content-type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: '{"name":"Winston"}',
  });
  assert.equal(valid.status, 200);
  assert.equal((await app.request("/unknown")).status, 404);
});

test("shutdown rejects new connections and lets an active request finish", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const router = new Hono<HttpEnvironment>();

  router.get("/slow", async (context) => {
    entered.resolve(undefined);
    await release.promise;

    return context.text("finished");
  });

  const host = startServer(readConfig({ PORT: "0" }), {
    groups: {
      owner: { router, authenticate: () => Promise.resolve({ kind: "owner", ownerId: "owner-1" }) },
    },
  });
  const request = fetch(new URL("/api/owner/slow", host.server.url));

  try {
    await entered.promise;
    const stopped = host.stop();
    assert.equal(host.stop(), stopped);

    await assert.rejects(fetch(new URL("/health/live", host.server.url), { keepalive: false }));
    release.resolve(undefined);

    assert.equal(await (await request).text(), "finished");
    await stopped;
  } finally {
    release.resolve(undefined);
    await host.stop();
  }
});

test("shutdown bounds an unresponsive handler", async () => {
  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const router = new Hono<HttpEnvironment>();

  router.get("/blocked", async (context) => {
    entered.resolve(undefined);
    await release.promise;

    return context.text("too late");
  });

  const host = startServer(readConfig({ PORT: "0", SHUTDOWN_TIMEOUT_MS: "25" }), {
    groups: {
      owner: { router, authenticate: () => Promise.resolve({ kind: "owner", ownerId: "owner-1" }) },
    },
  });
  const disconnected = assert.rejects(fetch(new URL("/api/owner/blocked", host.server.url)));

  try {
    await entered.promise;
    await host.stop();
    await disconnected;
  } finally {
    release.resolve(undefined);
    await host.stop();
  }
});
