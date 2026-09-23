import assert from "node:assert/strict";
import { test } from "bun:test";
import { cliExitCodes, type CliResult } from "@winston/contracts/cli";
import { parseCommand } from "../src/parse";
import { runCli } from "../src/run";

const id = "5f445ff8-9955-455a-8632-bff6fe58c745";

test("help and malformed arguments never call the gateway", async () => {
  let calls = 0;
  const execute = (): Promise<CliResult> => {
    calls += 1;
    return Promise.resolve({ version: 1, status: "ok", data: null });
  };
  for (const args of [
    [],
    ["--help"],
    ["help", "devices"],
    ["devices", "inspect", "-h", "--json"],
  ]) {
    const result = await runCli(args, execute);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /devices inspect/);
  }
  for (const args of [
    ["devices"],
    ["missing", "list"],
    ["accounts", "list", "extra"],
    ["devices", "inspect"],
    ["devices", "inspect", "--id", "bad"],
    ["devices", "inspect", "--id", id, "--id", id],
    ["accounts", "list", "--id", id],
    ["accounts", "list", "--token", "secret"],
    ["--help", "--help"],
    ["devices", "inspect", "--id"],
    ["help", "missing"],
    ["accounts", "list", "--json=true"],
  ]) {
    const result = await runCli(args, execute);
    assert.equal(result.exitCode, 2, JSON.stringify(args));
    assert.doesNotMatch(result.stderr, /secret/);
  }
  assert.equal(calls, 0);
});

test("command routing produces validated versioned requests", () => {
  assert.deepEqual(
    parseCommand([
      "accounts",
      "connect",
      "--service",
      "gmail",
      "--key",
      "itinerary",
      "--detail",
      "Find the itinerary",
      "--id",
      id,
    ]),
    {
      kind: "request",
      json: false,
      request: {
        version: 1,
        command: "accounts.connect",
        service: "gmail",
        key: "itinerary",
        detail: "Find the itinerary",
        id,
      },
    },
  );
  for (const args of [
    ["accounts", "connect"],
    ["accounts", "connect", "--service", "unknown", "--key", "x", "--detail", "x"],
    ["accounts", "list", "--service", "gmail"],
    ["help", "accounts", "--key", "x"],
  ])
    assert.throws(() => parseCommand(args));
  for (const command of ["devices.inspect", "operations.inspect", "operations.cancel"]) {
    assert.deepEqual(parseCommand([...command.split("."), "--id", id, "--json"]), {
      kind: "request",
      json: true,
      request: { version: 1, command, id },
    });
  }
  assert.deepEqual(parseCommand(["accounts", "list"]), {
    kind: "request",
    json: false,
    request: { version: 1, command: "accounts.list" },
  });
});

test("results preserve machine-readable states and never retry uncertain operations", async () => {
  for (const status of [
    "denied",
    "approval_required",
    "waiting",
    "unavailable",
    "unknown",
  ] as const) {
    const response: CliResult = {
      version: 1,
      status,
      message: "Check the operation",
      referenceId: id,
    };
    const result = await runCli(["operations", "cancel", "--id", id, "--json"], () =>
      Promise.resolve(response),
    );
    assert.equal(result.exitCode, cliExitCodes[status]);
    assert.deepEqual(JSON.parse(result.stdout), response);
    assert.equal(result.stderr, "");
  }
  let calls = 0;
  const unknown = await runCli(["operations", "cancel", "--id", id], () => {
    calls += 1;
    return Promise.reject(new Error("secret credential"));
  });
  assert.equal(calls, 1);
  assert.equal(unknown.exitCode, 7);
  assert.doesNotMatch(unknown.stderr, /secret/);
  const readable = await runCli(["devices", "list"], () =>
    Promise.resolve({
      version: 1,
      status: "waiting",
      message: "Device\u001b[31m unavailable",
    }),
  );
  assert.equal(readable.stderr.includes(String.fromCharCode(27)), false);
});
