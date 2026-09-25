import assert from "node:assert/strict";
import { test } from "bun:test";
import type { CliAuthority, CliRequest, CliResult } from "@winston/contracts/cli";
import { cliCommandInputSchema } from "@winston/contracts/cli";
import { callDeviceCommand } from "../src/device-command";
import { callGateway } from "../src/gateway";
import { parseCommand } from "../src/parse";
import { runCli } from "../src/run";

const deviceId = crypto.randomUUID();
const artifactId = crypto.randomUUID();
const actionId = crypto.randomUUID();
const executionId = crypto.randomUUID();
const args = [
  "devices",
  "write",
  "--id",
  deviceId,
  "--key",
  "deliver",
  "--path",
  "/fixtures/a b.txt",
  "--artifact",
  artifactId,
  "--revision",
  "2",
  "--json",
];
const authority: CliAuthority = {
  version: 1,
  environment: "local",
  workspaceId: crypto.randomUUID(),
  token: `wst_${"a".repeat(43)}`,
  controlToken: `wst_${"b".repeat(43)}`,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

function data(state: "running" | "succeeded" | "failed" | "unknown" | "canceled") {
  return {
    id: actionId,
    executionId,
    deviceId,
    state,
    exitCode: null,
    output: [],
    afterSequence: -1,
    hasMore: false,
  };
}

test("native write CLI binds an exact artifact and keeps overwrite explicit", () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "devices.write",
    id: deviceId,
    key: "deliver",
    path: "/fixtures/a b.txt",
    artifactId,
    revision: 2,
    overwrite: false,
  });
  const overwrite = parseCommand([...args, "--overwrite"]);
  assert.equal(overwrite.kind, "request");
  assert.equal(overwrite.request.command, "devices.write");
  assert.equal(overwrite.request.overwrite, true);
  for (const extra of [
    ["--transfer-id", crypto.randomUUID()],
    ["--sha256", "a".repeat(64)],
    ["--account", artifactId],
    ["--overwrite", "false"],
    ["--revision", "3"],
  ])
    assert.throws(() => parseCommand([...args, ...extra]));
  assert.throws(() =>
    parseCommand(args.map((value) => (value === "/fixtures/a b.txt" ? "relative.txt" : value))),
  );
  const revision = args.indexOf("--revision") + 1;
  for (const value of ["", "-1", "1.5", "1e2", "Infinity", "9007199254740992"]) {
    const invalid = [...args];
    invalid[revision] = value;
    assert.throws(() => parseCommand(invalid));
  }
  const schema = cliCommandInputSchema("devices.write");
  assert.equal(schema.additionalProperties, false);
});

test("native writes use control authority and poll results without redispatch", async () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.request.command, "devices.write");
  const initial = parsed.request;
  let destination = "";
  await callGateway(authority, initial, (url, init) => {
    destination = url;
    assert.ok(authority.controlToken);
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Bearer ${authority.controlToken}`,
    );
    assert.ok(typeof init.body === "string");
    assert.deepEqual(JSON.parse(init.body), initial);
    return Promise.resolve(
      Response.json({ version: 1, status: "approval_required", message: "Approval required." }),
    );
  });
  assert.equal(destination, "http://127.0.0.1:3001/api/tasks/cli/control");
  for (const state of ["succeeded", "failed", "canceled", "unknown"] as const) {
    const calls: CliRequest[] = [];
    const result = await callDeviceCommand(authority, initial, {
      wait: () => Promise.resolve(),
      call: (_authority, request): Promise<CliResult> => {
        calls.push(request);
        return Promise.resolve({
          version: 1,
          status: "ok",
          data: data(calls.length === 1 ? "running" : state),
        });
      },
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { version: 1, command: "devices.result", id: actionId, after: -1 });
    assert.equal(result.status, state === "unknown" ? "unknown" : "ok");
    const output = await runCli(args, () => Promise.resolve(result));
    assert.equal(output.exitCode, state === "succeeded" ? 0 : state === "unknown" ? 7 : 1);
  }
});
