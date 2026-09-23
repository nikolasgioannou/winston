import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import type { GoogleConnections } from "@winston/adapters/google";
import { createApi, type HttpEnvironment, type RequestLog } from "../src/http/app";
import {
  createConnectionCallbackRouter,
  createConnectionOwnerRouter,
} from "../src/http/connections";

test("Google connection routes require owner session and origin, and never reflect provider secrets", async () => {
  let authenticated = false;
  let starts = 0;
  let finishes = 0;
  const logs: RequestLog[] = [];
  const store: GoogleConnections = {
    access: () => Promise.reject(new Error("unused")),
    rejected: () => Promise.reject(new Error("unused")),
    disconnect: () => Promise.reject(new Error("unused")),
    list: () => Promise.resolve([]),
    start: () => {
      starts += 1;
      return Promise.resolve({ url: "https://accounts.google.com/fixture" });
    },
    finish: () => {
      finishes += 1;
      return Promise.reject(new Error("synthetic-secret-canary"));
    },
    calendars: () => Promise.resolve([]),
    selectCalendars: () => Promise.reject(new Error("unused")),
  };
  const { app } = createApi({
    ownerOrigin: "https://web.example",
    log: (entry) => {
      logs.push(entry);
    },
    groups: {
      owner: {
        router: new Hono<HttpEnvironment>().route(
          "/connections",
          createConnectionOwnerRouter(store),
        ),
        authenticate: () =>
          Promise.resolve(
            authenticated ? { kind: "owner", ownerId: "fixture", sessionId: "session" } : null,
          ),
      },
      callback: {
        router: createConnectionCallbackRouter(store, "https://web.example"),
        authenticate: () =>
          Promise.resolve(
            authenticated
              ? { kind: "callback", provider: "google", ownerId: "fixture", sessionId: "session" }
              : null,
          ),
      },
    },
  });
  const callback = `/callbacks/google/connections?state=${"a".repeat(43)}&code=synthetic-secret-canary`;
  assert.equal((await app.request(callback)).status, 401);
  assert.equal(finishes, 0);
  authenticated = true;
  assert.equal(
    (
      await app.request("/api/owner/connections/google", {
        method: "POST",
        body: '{"service":"gmail"}',
      })
    ).status,
    403,
  );
  assert.equal(starts, 0);
  assert.equal(
    (
      await app.request("/api/owner/connections/google", {
        method: "POST",
        headers: { Origin: "https://web.example", "Content-Type": "application/json" },
        body: '{"service":"gmail"}',
      })
    ).status,
    200,
  );
  assert.equal(starts, 1);
  const response = await app.request(callback);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "https://web.example/?connection_result=failed");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.ok(!JSON.stringify(logs).includes("canary"));
  assert.ok(!(await response.text()).includes("canary"));
});
