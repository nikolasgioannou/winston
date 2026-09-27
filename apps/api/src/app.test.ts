import { describe, expect, test } from "bun:test";
import type { Db } from "@winston/db/client";
import { testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { createApp } from "./app.ts";

const lines: Record<string, unknown>[] = [];
const logger = createLogger("api-test", {
  pretty: false,
  destination: {
    write: (line: string) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
  },
});
const db = await testDb();

describe("api", () => {
  test("GET /health is ok when Postgres answers", async () => {
    const res = await createApp({ db, logger }).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /health is 503 when Postgres doesn't", async () => {
    const brokenDb = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as Db;
    const res = await createApp({ db: brokenDb, logger }).request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  test("unhandled errors return a generic 500, log the details, and carry the request id", async () => {
    const app = createApp({ db, logger });
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
      lines.some(
        (l) => l.msg === "unhandled error" && l.requestId === "req-123",
      ),
    ).toBe(true);
  });

  test("unknown routes are a JSON 404, and every response has a request id", async () => {
    const res = await createApp({ db, logger }).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
