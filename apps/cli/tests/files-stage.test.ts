import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "bun:test";
import { parseCommand } from "../src/parse";
import { callGateway } from "../src/gateway";

test("file staging requires exact catalog identity and uses task control authority", async () => {
  const id = randomUUID();
  const args = ["files", "stage", "--id", id, "--key", "attachment"];
  assert.throws(() => parseCommand(args));
  for (const revision of ["-1", "1.1", "", "1e1", "NaN"])
    assert.throws(() => parseCommand([...args, "--revision", revision]));
  const parsed = parseCommand([...args, "--revision", "2"]);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "files.stage",
    id,
    revision: 2,
    key: "attachment",
  });
  assert.throws(() => parseCommand([...args, "--revision", "2", "--path", "/tmp/other"]));
  const authority = {
    version: 1 as const,
    environment: "local" as const,
    workspaceId: randomUUID(),
    token: `wst_${"a".repeat(43)}`,
    controlToken: `wst_${"b".repeat(43)}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  let calls = 0;
  await callGateway(authority, parsed.request, (url, init) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:3001/api/tasks/cli/control");
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Bearer ${authority.controlToken}`,
    );
    assert.ok(typeof init.body === "string");
    assert.deepEqual(JSON.parse(init.body), parsed.request);
    return Promise.resolve(
      Response.json({ version: 1, status: "waiting", message: "Approve file." }),
    );
  });
  assert.equal(calls, 1);
});
