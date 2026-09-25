import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { createWorkspaceAuthority } from "../src/authority";

test("artifact authority uses its fixed endpoint and matches the complete descriptor", async () => {
  const transfer = {
    ownerId: randomUUID(),
    workspaceId: randomUUID(),
    workspaceRevision: 1,
    transferId: randomUUID(),
    artifactId: randomUUID(),
    artifactRevision: 2,
    task: { id: randomUUID(), revision: 3, generation: 4 },
    size: 0,
    sha256: "a".repeat(64),
  };
  const token = `wat_${"x".repeat(43)}`;
  let mode = "allow";
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      assert.equal(new URL(request.url).pathname, "/api/transfers/artifacts/authorize");
      assert.equal(request.headers.get("Authorization"), `Bearer ${token}`);
      assert.equal(request.headers.get("Cookie"), null);
      assert.deepEqual(await request.json(), transfer);
      if (mode === "deny") return new Response(null, { status: 403 });
      if (mode === "redirect") return Response.redirect("https://example.com", 307);
      if (mode === "oversized") return new Response("x".repeat(5000));
      return Response.json(
        mode === "mismatch" ? { ...transfer, task: { ...transfer.task, generation: 5 } } : transfer,
      );
    },
  });
  try {
    const authority = createWorkspaceAuthority(server.url.origin);
    await assert.rejects(authority.artifact(`wit_${"x".repeat(43)}`, transfer));
    assert.equal(calls, 0);
    assert.equal(await authority.artifact(token, transfer), true);
    for (const state of ["deny", "mismatch"]) {
      mode = state;
      assert.equal(await authority.artifact(token, transfer), false);
    }
    for (const state of ["redirect", "oversized"]) {
      mode = state;
      await assert.rejects(authority.artifact(token, transfer));
    }
  } finally {
    await server.stop(true);
  }
});
