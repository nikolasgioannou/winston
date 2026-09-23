import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceOperation } from "@winston/contracts/workspace";
import { createWorkspaceAuthority } from "../src/authority";
import { createWorkspaceHandler } from "../src/http";
import { openWorkspaceJournal } from "../src/journal";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture() {
  const identity = { ownerId: randomUUID(), workspaceId: randomUUID() };
  const root = mkdtempSync(join(tmpdir(), "winston-http-"));
  cleanup.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const journal = openWorkspaceJournal({ root, identity, initialize: true });
  cleanup.push(() => {
    journal.close();
  });
  let calls = 0;
  let mode = "allow";
  const token = `wst_${"a".repeat(43)}`;
  const worker = randomUUID();
  const authority = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1;
      expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
      expect(request.headers.get("X-Winston-Worker")).toBe(worker);
      expect(request.headers.get("Cookie")).toBeNull();
      expect(new URL(request.url).pathname).toBe(
        `/api/tasks/workspaces/${identity.workspaceId}/authorize`,
      );
      const operation = (await request.json()) as WorkspaceOperation;
      if (mode === "deny") return new Response(null, { status: 403 });
      if (mode === "outage") return new Response("private details", { status: 500 });
      if (mode === "redirect") return Response.redirect("https://example.com/", 307);
      if (mode === "oversized") return new Response("a".repeat(20_000));
      if (mode === "mismatch") operation.generation += 1;
      return Response.json({ version: 1, allowed: true, operation, workspaceRevision: 1 });
    },
  });
  cleanup.push(async () => {
    await authority.stop(true);
  });
  const runtime = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 16_384,
    fetch: createWorkspaceHandler({
      identity,
      journal,
      authorize: createWorkspaceAuthority(authority.url.origin),
    }),
  });
  cleanup.push(async () => {
    await runtime.stop(true);
  });
  const operation: WorkspaceOperation = {
    version: 1,
    identity,
    operationId: randomUUID(),
    taskId: randomUUID(),
    revision: 0,
    generation: 1,
    kind: "workspace:inspect",
    inputHash: createHash("sha256").update("{}").digest("hex"),
  };
  return {
    operation,
    journal,
    runtime,
    calls: () => calls,
    mode(value: string) {
      mode = value;
    },
    send(path = "/v1/inspect", body: unknown = { operation, input: {} }, authenticated = true) {
      return fetch(new URL(path, runtime.url), {
        method: "POST",
        headers: authenticated
          ? {
              Authorization: `Bearer ${token}`,
              "X-Winston-Worker": worker,
              Cookie: "must-not-be-forwarded=secret",
            }
          : {},
        body: JSON.stringify(body),
      });
    },
  };
}

test("inspection uses live authority and durable outcomes on duplicate and status requests", async () => {
  const f = fixture();
  const first = await f.send();
  expect(first.status).toBe(200);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const record: unknown = await first.json();
  expect(record).toMatchObject({ state: "completed", request: f.operation });
  expect(await (await f.send()).json()).toEqual(record);
  expect(await (await f.send("/v1/status")).json()).toEqual(record);
  expect(f.calls()).toBe(3);
  f.mode("deny");
  expect((await f.send()).status).toBe(403);
  expect((await f.send("/v1/status")).status).toBe(403);
  expect(f.journal.read(f.operation)?.state).toBe("completed");
});

test("invalid input and foreign identity never reach the authorization service", async () => {
  const f = fixture();
  expect((await f.send("/v1/inspect", {}, false)).status).toBe(401);
  for (const operation of [
    { ...f.operation, inputHash: "a".repeat(64) },
    { ...f.operation, kind: "command:execute" },
    { ...f.operation, extra: true },
  ]) {
    expect((await f.send("/v1/inspect", { operation, input: {} })).status).toBe(400);
  }
  expect(
    (
      await f.send("/v1/inspect", {
        operation: { ...f.operation, identity: { ...f.operation.identity, ownerId: randomUUID() } },
        input: {},
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.send("/v1/inspect", { operation: f.operation, input: { shell: "no" } })).status,
  ).toBe(400);
  expect((await f.send("/v1/inspect", "a".repeat(20_000))).status).toBe(413);
  expect(f.calls()).toBe(0);
});

test("unavailable, redirected, malformed and mismatched authority never claim work", async () => {
  const f = fixture();
  for (const mode of ["outage", "redirect", "oversized", "mismatch", "deny"]) {
    f.mode(mode);
    const response = await f.send();
    expect(response.status).toBe(["mismatch", "deny"].includes(mode) ? 403 : 503);
    expect(await response.text()).not.toContain("private details");
    expect(f.journal.read(f.operation)).toBeNull();
  }
});

test("operation conflicts and uncertain outcomes cannot be replayed", async () => {
  const f = fixture();
  expect((await f.send("/v1/status")).status).toBe(404);
  f.journal.start(f.operation);
  f.journal.recoverInterrupted();
  expect(await (await f.send()).json()).toMatchObject({ state: "unknown", outcome: null });
  expect(
    (
      await f.send("/v1/inspect", {
        operation: { ...f.operation, taskId: randomUUID() },
        input: {},
      })
    ).status,
  ).toBe(409);
  expect(f.journal.read(f.operation)?.state).toBe("unknown");
});

test("authority configuration rejects insecure remote origins and embedded credentials", () => {
  for (const origin of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/other",
    "https://example.com/?secret=x",
  ]) {
    expect(() => createWorkspaceAuthority(origin)).toThrow();
  }
});
