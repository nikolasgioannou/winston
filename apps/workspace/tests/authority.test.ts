import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";
import { createWorkspaceAuthority } from "../src/authority";

test("authority binds command and recovery responses without forwarding ambient credentials", async () => {
  const operation: WorkspaceCommand["operation"] = {
    version: 1,
    identity: { ownerId: randomUUID(), workspaceId: randomUUID() },
    operationId: randomUUID(),
    taskId: randomUUID(),
    revision: 2,
    generation: 3,
    kind: "command:execute",
    inputHash: "a".repeat(64),
  };
  const command: WorkspaceCommand = {
    operation,
    input: { argv: ["echo"], cwd: "/data/home", env: {}, timeoutMs: 1000, maxOutputBytes: 1024 },
    dispatch: { id: randomUUID(), token: `wda_${"x".repeat(43)}` },
  };
  const credential = {
    token: `wst_${"a".repeat(43)}`,
    kind: "worker" as const,
    subjectId: randomUUID(),
    resourceId: operation.identity.workspaceId,
    operation: "workspace:execute" as const,
  };
  let endpoint = "authorize-command";
  let mode = "allow";
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1;
      expect(new URL(request.url).pathname).toBe(
        `/api/tasks/workspaces/${operation.identity.workspaceId}/${endpoint}`,
      );
      expect(request.headers.get("Authorization")).toBe(`Bearer ${credential.token}`);
      expect(request.headers.get("Cookie")).toBeNull();
      expect(await request.json()).toEqual(
        ["authorize-command", "authorize-cli"].includes(endpoint) ? command : operation,
      );
      if (mode === "deny") return new Response(null, { status: 403 });
      if (mode === "outage") return new Response(null, { status: 503 });
      if (mode === "redirect") return Response.redirect("https://example.com/", 307);
      if (mode === "oversized") return new Response("x".repeat(20_000));
      if (endpoint === "authorize-cli")
        return Response.json({
          version: 1,
          environment: "local",
          workspaceId: mode === "mismatch" ? randomUUID() : operation.identity.workspaceId,
          token: `wst_${"g".repeat(43)}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      return Response.json({
        version: 1,
        allowed: true,
        workspaceRevision: 1,
        operation: mode === "mismatch" ? { ...operation, operationId: randomUUID() } : operation,
      });
    },
  });
  try {
    const authority = createWorkspaceAuthority(server.url.origin);
    expect(await authority.command(credential, command)).toBe(true);
    expect(await authority.control(credential, operation)).toBe(false);
    expect(calls).toBe(1);
    for (const scope of ["observe", "cancel"] as const) {
      endpoint = `authorize-${scope}`;
      const request = { ...credential, operation: `workspace:${scope}` as const };
      expect(await authority.control(request, operation)).toBe(true);
      expect(await authority.command(request, command)).toBe(false);
    }
    endpoint = "authorize-command";
    for (const state of ["deny", "mismatch"]) {
      mode = state;
      expect(await authority.command(credential, command)).toBe(false);
    }
    for (const state of ["outage", "redirect", "oversized"]) {
      mode = state;
      await assert.rejects(authority.command(credential, command));
    }
    endpoint = "authorize-cli";
    mode = "allow";
    expect((await authority.gateway(credential, command)).workspaceId).toBe(
      operation.identity.workspaceId,
    );
    for (const state of ["deny", "outage", "redirect", "oversized", "mismatch"]) {
      mode = state;
      await assert.rejects(authority.gateway(credential, command));
    }
  } finally {
    await server.stop(true);
  }
});
