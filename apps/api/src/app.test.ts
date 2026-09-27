import { describe, expect, test } from "bun:test";
import type { Db } from "@winston/db/client";
import { testDb } from "@winston/db/testing";
import { createApp } from "./app.ts";
import { testDeps } from "./testing.ts";

const db = await testDb();
const { deps, logs } = testDeps(db);

describe("api", () => {
  test("GET /health is ok when Postgres answers", async () => {
    const res = await createApp(deps).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /health is 503 when Postgres doesn't", async () => {
    const brokenDb = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Db;
    const res = await createApp({ ...deps, db: brokenDb }).request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("unhandled errors return a generic 500, log the details, and carry the request id", async () => {
    const app = createApp(deps);
    app.get("/boom", () => {
      throw new Error("secret internal detail");
    });
    const res = await app.request("/boom", {
      headers: { "X-Request-Id": "req-123" },
    });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("secret internal detail");
    expect(JSON.parse(body)).toEqual({
      error: "internal_error",
      requestId: "req-123",
    });
    expect(
      logs.some(
        (l) => l.msg === "unhandled error" && l.requestId === "req-123",
      ),
    ).toBe(true);
  });

  test("unknown routes are a JSON 404, and every response has a request id", async () => {
    const res = await createApp(deps).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
