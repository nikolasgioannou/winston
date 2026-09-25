import assert from "node:assert/strict";
import { test } from "bun:test";
import type { CliAuthority, CliRequest, CliResult } from "@winston/contracts/cli";
import { callDeviceCommand } from "../src/device-command";
import { parseCommand } from "../src/parse";
import { runCli } from "../src/run";

const deviceId = crypto.randomUUID();
const id = crypto.randomUUID();
const executionId = crypto.randomUUID();
const args = [
  "devices",
  "read",
  "--id",
  deviceId,
  "--key",
  "capture",
  "--path",
  "/fixtures/a b.txt",
  "--json",
];
const artifact = {
  id: crypto.randomUUID(),
  revision: 2,
  name: "a b.txt",
  mediaType: "application/octet-stream",
  size: 4,
  sha256: "a".repeat(64),
};
const authority: CliAuthority = {
  version: 1,
  environment: "local",
  workspaceId: crypto.randomUUID(),
  token: `wst_${"a".repeat(43)}`,
  controlToken: `wst_${"b".repeat(43)}`,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

function data(state: "running" | "succeeded" | "failed" | "unknown") {
  return {
    id,
    executionId,
    deviceId,
    state,
    exitCode: null,
    output: [],
    afterSequence: -1,
    hasMore: false,
  };
}

test("file capture CLI preserves literal paths and rejects unsupported options", () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.deepEqual(parsed.request, {
    version: 1,
    command: "devices.read",
    id: deviceId,
    key: "capture",
    path: "/fixtures/a b.txt",
  });
  assert.throws(() => parseCommand([...args, "--transfer-id", crypto.randomUUID()]));
  assert.throws(() => parseCommand([...args, "--account", crypto.randomUUID()]));
  assert.throws(() =>
    parseCommand(args.map((value) => (value === "/fixtures/a b.txt" ? "relative.txt" : value))),
  );
});

test("file capture polling never reexecutes and requires the artifact receipt", async () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.request.command, "devices.read");
  for (const mode of ["complete", "missing-artifact", "unknown", "failed"] as const) {
    const calls: CliRequest[] = [];
    const result = await callDeviceCommand(authority, parsed.request, {
      wait: () => Promise.resolve(),
      call: (_authority, request): Promise<CliResult> => {
        calls.push(request);
        const receipt =
          calls.length === 1
            ? data("running")
            : data(mode === "failed" ? "failed" : mode === "unknown" ? "unknown" : "succeeded");
        return Promise.resolve({
          version: 1,
          status: "ok",
          data: mode === "complete" && calls.length > 1 ? { ...receipt, artifact } : receipt,
        });
      },
    });
    assert.equal(result.status, mode === "complete" || mode === "failed" ? "ok" : "unknown");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { version: 1, command: "devices.result", id, after: -1 });
    const printed = await runCli(args, () => Promise.resolve(result));
    assert.equal(printed.exitCode, mode === "complete" ? 0 : mode === "failed" ? 1 : 7);
  }
  const missing = await runCli(args, () =>
    Promise.resolve({ version: 1, status: "ok", data: data("succeeded") }),
  );
  assert.equal(missing.exitCode, 7);
});
