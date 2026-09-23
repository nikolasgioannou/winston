import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, openSync, closeSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { CliAuthority } from "@winston/contracts/cli";
import { readAuthority } from "../src/authority";
import { callGateway } from "../src/gateway";

function authority(): CliAuthority {
  return {
    version: 1,
    environment: "production",
    token: `wst_${"a".repeat(43)}`,
    workspaceId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("file delivery requires control authority while status uses read authority", async () => {
  const value = { ...authority(), controlToken: `wst_${"c".repeat(43)}` };
  for (const command of ["files.send", "files.status"] as const) {
    const result = await callGateway(
      value,
      command === "files.send"
        ? { version: 1, command, id: randomUUID(), key: "file" }
        : { version: 1, command, id: randomUUID() },
      (url, init) => {
        assert.equal(url.endsWith("/control"), command === "files.send");
        assert.equal(
          new Headers(init.headers).get("Authorization"),
          `Bearer ${command === "files.send" ? value.controlToken : value.token}`,
        );
        return Promise.resolve(
          Response.json({ version: 1, status: "ok", data: { state: "pending" } }),
        );
      },
    );
    assert.equal(result.status, "ok");
  }
});

test("keyed reads require control authority for approval parking", async () => {
  const value = authority();
  const request = {
    version: 1 as const,
    command: "gmail.search" as const,
    accountId: randomUUID(),
    query: "fixture",
    limit: 1,
    key: "read-fixture",
  };
  const controlToken = `wst_${"c".repeat(43)}`;
  let called = false;
  const send = (url: string, init: RequestInit) => {
    called = true;
    assert.equal(url, "https://winston-628.fly.dev/api/tasks/cli/control");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${controlToken}`);
    return Promise.resolve(
      Response.json({ version: 1, status: "waiting", message: "Approve read" }),
    );
  };
  assert.equal((await callGateway(value, request, send)).status, "denied");
  assert.equal(called, false);
  assert.equal((await callGateway({ ...value, controlToken }, request, send)).status, "waiting");
  assert.equal(called, true);
});

test("connection setup uses control authority without falling back to discovery credentials", async () => {
  const value = authority();
  const request = {
    version: 1,
    command: "accounts.connect",
    service: "gmail",
    key: "fixture",
    detail: "Connect Gmail",
  } as const;
  let calls = 0;
  const controlToken = `wst_${"c".repeat(43)}`;
  const send = (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(url, "https://winston-628.fly.dev/api/tasks/cli/control");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${controlToken}`);
    return Promise.resolve(
      Response.json({ version: 1, status: "waiting", message: "Connect account" }),
    );
  };
  assert.equal((await callGateway(value, request, send)).status, "denied");
  assert.equal(calls, 0);
  assert.equal((await callGateway({ ...value, controlToken }, request, send)).status, "waiting");
  assert.equal(calls, 1);
});

test("authority can be reread from an anonymous descriptor without using a path or stdin", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-cli-"));
  const path = join(directory, "authority");
  const value = authority();
  writeFileSync(path, JSON.stringify(value), { mode: 0o400 });
  const fd = openSync(path, "r");
  unlinkSync(path);
  try {
    assert.deepEqual(readAuthority(fd), value);
    assert.deepEqual(readAuthority(fd), value);
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true });
  }
});

test("gateway credentials only go to fixed application destinations without redirects or cookies", async () => {
  const value = authority();
  let calls = 0;
  const send = (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(url, "https://winston-628.fly.dev/api/tasks/cli");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${value.token}`);
    assert.ok(init.signal);
    return Promise.resolve(Response.json({ version: 1, status: "ok", data: [] }));
  };
  const request = { version: 1, command: "accounts.list" } as const;
  assert.equal((await callGateway(value, request, send)).status, "ok");
  assert.equal(
    (await callGateway({ ...value, expiresAt: new Date(0).toISOString() }, request, send)).status,
    "denied",
  );
  await assert.rejects(
    callGateway(
      { ...value, environment: "https://foreign.invalid" } as unknown as CliAuthority,
      request,
      send,
    ),
  );
  await assert.rejects(
    callGateway({ ...value, origin: "https://foreign.invalid" } as CliAuthority, request, send),
  );
  assert.equal(calls, 1);
});

test("gateway rejects oversized and malformed responses and maps authentication failure", async () => {
  const value = authority();
  const request = { version: 1, command: "devices.list" } as const;
  const result = await callGateway(value, request, () =>
    Promise.resolve(new Response("private", { status: 401 })),
  );
  assert.equal(result.status, "denied");
  for (const response of [
    new Response("x".repeat(1_048_577)),
    Response.json({ unexpected: "private" }),
    new Response("unavailable", { status: 503 }),
  ]) {
    await assert.rejects(callGateway(value, request, () => Promise.resolve(response)));
  }
});

test("cancellation uses a separate control credential and never falls back to read authority", async () => {
  const value = authority();
  const request = { version: 1, command: "operations.cancel", id: randomUUID() } as const;
  let calls = 0;
  const controlToken = `wst_${"c".repeat(43)}`;
  const send = (url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(url, "https://winston-628.fly.dev/api/tasks/cli/control");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${controlToken}`);
    return Promise.resolve(
      Response.json({
        version: 1,
        status: "waiting",
        message: "Cancellation requested",
        referenceId: request.id,
      }),
    );
  };
  assert.equal((await callGateway(value, request, send)).status, "denied");
  assert.equal(calls, 0);
  assert.equal((await callGateway({ ...value, controlToken }, request, send)).status, "waiting");
  assert.equal(calls, 1);
});
