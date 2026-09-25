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
  "command",
  "--id",
  deviceId,
  "--key",
  "literal",
  "--cwd",
  "/tmp",
  "--argv",
  '["/bin/echo","$(not-expanded); literal"]',
  "--json",
];
const data = (state: "running" | "succeeded" | "failed" | "unknown") => ({
  id,
  executionId,
  deviceId,
  state,
  exitCode: state === "succeeded" ? 0 : null,
  output: [],
  afterSequence: -1,
  hasMore: false,
});

test("device command parsing preserves literal argv and reports failed execution with a nonzero exit", async () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.request.command, "devices.command");
  assert.deepEqual(parsed.request.operation, {
    kind: "command",
    executable: "/bin/echo",
    arguments: ["$(not-expanded); literal"],
    directory: "/tmp",
  });
  for (const argv of ["null", "[]", '["relative"]', '["/bin/echo",4]'])
    assert.throws(() => parseCommand([...args.slice(0, -2), argv]));
  assert.throws(() => parseCommand([...args, "--account", crypto.randomUUID()]));
  const result = parseCommand(["devices", "result", "--id", id, "--after", "4"]);
  assert.equal(result.kind, "request");
  assert.deepEqual(result.request, { version: 1, command: "devices.result", id, after: 4 });
  for (const state of ["succeeded", "failed", "unknown"] as const) {
    const printed = await runCli(args, () =>
      Promise.resolve({ version: 1, status: "ok", data: data(state) }),
    );
    assert.equal(printed.exitCode, state === "succeeded" ? 0 : state === "failed" ? 1 : 7);
    assert.ok(printed.stdout.includes(id));
  }
});

test("device CLI polls only the original result and preserves uncertainty without replay", async () => {
  const parsed = parseCommand(args);
  assert.equal(parsed.kind, "request");
  assert.equal(parsed.request.command, "devices.command");
  for (const mode of [
    "completed",
    "failed",
    "unknown",
    "lost-poll",
    "changed-id",
    "expired",
    "approval",
  ] as const) {
    let clock = 1_800_000_000_000;
    const authority: CliAuthority = {
      version: 1,
      environment: "local",
      workspaceId: crypto.randomUUID(),
      token: `wst_${"a".repeat(43)}`,
      controlToken: `wst_${"b".repeat(43)}`,
      expiresAt: new Date(clock + (mode === "expired" ? 500 : 300_000)).toISOString(),
    };
    const seen: CliRequest[] = [];
    const result = await callDeviceCommand(authority, parsed.request, {
      now: () => clock,
      wait: () => {
        clock += 1000;
        return Promise.resolve();
      },
      call: (_authority, request): Promise<CliResult> => {
        seen.push(request);
        if (seen.length === 1)
          return Promise.resolve(
            mode === "approval"
              ? {
                  version: 1,
                  status: "approval_required",
                  referenceId: id,
                  message: "Approval required",
                }
              : { version: 1, status: "ok", data: data("running") },
          );
        assert.deepEqual(request, { version: 1, command: "devices.result", id, after: -1 });
        if (mode === "lost-poll") return Promise.reject(new Error("Network failed"));
        const receipt = data(
          mode === "failed" ? "failed" : mode === "unknown" ? "unknown" : "succeeded",
        );
        return Promise.resolve({
          version: 1,
          status: "ok",
          data: mode === "changed-id" ? { ...receipt, executionId: crypto.randomUUID() } : receipt,
        });
      },
    });
    assert.equal(seen.filter((request) => request.command === "devices.command").length, 1);
    assert.equal(
      result.status,
      mode === "completed" || mode === "failed"
        ? "ok"
        : mode === "approval"
          ? "approval_required"
          : "unknown",
    );
    if (result.status !== "ok") assert.equal(result.referenceId, id);
    assert.equal(seen.length, mode === "expired" || mode === "approval" ? 1 : 2);
  }
});
