import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { createWorkspaceClient, archiveCommandOutput } from "@winston/adapters/workspace";
import type { WorkspaceCommand } from "@winston/contracts/workspace-commands";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function fixture() {
  const command: WorkspaceCommand = {
    operation: {
      version: 1,
      identity: { ownerId: randomUUID(), workspaceId: randomUUID() },
      operationId: randomUUID(),
      taskId: randomUUID(),
      revision: 1,
      generation: 1,
      kind: "command:execute",
      inputHash: "a".repeat(64),
    },
    input: { argv: ["echo"], cwd: "/data/home", env: {}, timeoutMs: 1000, maxOutputBytes: 16384 },
    dispatch: { id: randomUUID(), token: `wda_${"d".repeat(43)}` },
  };
  const bytes = Buffer.alloc(8192, "x");
  const metadata = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    preview: "x".repeat(1024),
    truncated: true,
  };
  const outcome = {
    exitCode: 0,
    signal: null,
    reason: "exited",
    durationMs: 1,
    stdout: metadata,
    stderr: metadata,
  };
  let mode = "ok";
  let calls = 0;
  const token = `wst_${"a".repeat(43)}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls += 1;
      expect(request.headers.get("Authorization")).toBe(`Bearer ${token}`);
      expect(request.headers.get("Cookie")).toBeNull();
      const path = new URL(request.url).pathname;
      expect(await request.json()).toEqual(
        path.endsWith("start") || path.endsWith("renew") ? command : command.operation,
      );
      if (mode === "outage") return new Response("private", { status: 503 });
      if (mode === "redirect") return Response.redirect("https://example.com/", 307);
      if (mode === "oversized") return new Response("x".repeat(20_000));
      if (path.endsWith("stdout") || path.endsWith("stderr"))
        return new Response(bytes, {
          headers: {
            "Content-Length": String(bytes.length),
            "X-Winston-Output-SHA256": mode === "hash" ? "b".repeat(64) : metadata.sha256,
          },
        });
      return Response.json({
        request:
          mode === "foreign"
            ? { ...command.operation, operationId: randomUUID() }
            : command.operation,
        state: mode === "running" ? "running" : "completed",
        outcome:
          mode === "running" ? null : { state: "completed", result: JSON.stringify(outcome) },
      });
    },
  });
  cleanup.push(async () => {
    await server.stop(true);
  });
  const credential = {
    token,
    kind: "worker" as const,
    subjectId: randomUUID(),
    operation: "workspace:observe" as const,
    resourceId: command.operation.identity.workspaceId,
  };
  return {
    client: createWorkspaceClient(server.url.origin),
    command,
    credential,
    bytes,
    metadata,
    mode(value: string) {
      mode = value;
    },
    calls: () => calls,
  };
}

test("workspace transport binds records and streams full output beyond its bounded preview", async () => {
  const f = fixture();
  expect(
    (await f.client.start({ ...f.credential, operation: "workspace:execute" }, f.command)).state,
  ).toBe("completed");
  expect(
    (await f.client.renew({ ...f.credential, operation: "workspace:execute" }, f.command)).state,
  ).toBe("completed");
  expect((await f.client.control(f.credential, f.command.operation)).state).toBe("completed");
  const output = await f.client.output(f.credential, f.command.operation, "stdout");
  expect(output.metadata).toEqual(f.metadata);
  expect(Buffer.from(await new Response(output.stream).arrayBuffer())).toEqual(f.bytes);
});

test("scope violations, foreign records, redirects and malformed output cannot pass", async () => {
  const f = fixture();
  await assert.rejects(f.client.start(f.credential, f.command), /scope mismatch/);
  await assert.rejects(
    f.client.output(
      { ...f.credential, operation: "workspace:cancel" },
      f.command.operation,
      "stdout",
    ),
    /scope mismatch/,
  );
  await assert.rejects(
    f.client.output({ ...f.credential, resourceId: randomUUID() }, f.command.operation, "stdout"),
    /scope mismatch/,
  );
  expect(f.calls()).toBe(0);
  for (const mode of ["foreign", "redirect", "oversized", "running", "hash"]) {
    f.mode(mode);
    await assert.rejects(f.client.output(f.credential, f.command.operation, "stdout"));
  }
  f.mode("outage");
  const before = f.calls();
  await assert.rejects(
    f.client.start({ ...f.credential, operation: "workspace:execute" }, f.command),
    /503/,
  );
  expect(f.calls() - before).toBe(1);
});

test("output artifact intake rejects a different owner before fetching data", async () => {
  const f = fixture();
  await assert.rejects(
    archiveCommandOutput({
      ownerId: randomUUID(),
      credential: f.credential,
      operation: f.command.operation,
      channel: "stdout",
      client: f.client,
      artifacts: {
        upload() {
          throw new Error("Must not upload");
        },
      },
    }),
    /owner mismatch/,
  );
  expect(f.calls()).toBe(0);
});

test("workspace origins must be trusted HTTPS, Flycast, or loopback endpoints", () => {
  for (const origin of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/path",
    "https://example.com/?secret=x",
  ])
    expect(() => createWorkspaceClient(origin)).toThrow();
  expect(() => createWorkspaceClient("http://fixture.flycast")).not.toThrow();
});
