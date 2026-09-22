import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { z } from "zod";
import {
  acceptsDeviceExecution,
  decodeDeviceMessage,
  encodeDeviceMessage,
  deviceFrameLimit,
} from "@winston/contracts/devices";

const fixture = z.strictObject({ name: z.string(), message: z.unknown() });
const fixtures = z
  .strictObject({
    valid: z.array(fixture),
    invalid: z.array(fixture),
    rawInvalid: z.array(z.string()),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../../device-protocol/fixtures/messages.json", import.meta.url),
        "utf8",
      ),
    ) as unknown,
  );

for (const item of fixtures.valid) {
  test(`device protocol accepts ${item.name}`, () => {
    assert.deepEqual(decodeDeviceMessage(JSON.stringify(item.message)), item.message);
    assert.deepEqual(
      decodeDeviceMessage(encodeDeviceMessage(decodeDeviceMessage(JSON.stringify(item.message)))),
      item.message,
    );
  });
}

for (const item of fixtures.invalid) {
  test(`device protocol rejects ${item.name}`, () => {
    assert.throws(() => decodeDeviceMessage(JSON.stringify(item.message)));
  });
}

test("device protocol rejects oversized and malformed frames", () => {
  const valid = fixtures.valid[0];
  assert.ok(valid);
  const oversized = JSON.stringify(valid.message) + " ".repeat(deviceFrameLimit);
  assert.throws(() => decodeDeviceMessage(oversized), /exceeds limit/);
  for (const frame of fixtures.rawInvalid) {
    assert.throws(() => decodeDeviceMessage(frame));
  }
});

test("execution acceptance fences session, generation, revision, capability and deadline", () => {
  const item = fixtures.valid.find((item) => item.name === "valid-2-execute");
  assert.ok(item);
  const message = decodeDeviceMessage(JSON.stringify(item.message));
  const id = "11111111-1111-4111-8111-111111111111";
  const context = {
    deviceId: id,
    sessionId: id,
    generation: 2,
    taskId: id,
    taskRevision: 3,
    now: 1000,
    capabilities: ["command"] as const,
  };
  assert.ok(acceptsDeviceExecution(message, context));

  for (const override of [
    { deviceId: "other" },
    { sessionId: "other" },
    { generation: 3 },
    { taskId: "other" },
    { taskRevision: 4 },
    { now: 2000 },
    { capabilities: [] },
  ]) {
    assert.equal(acceptsDeviceExecution(message, { ...context, ...override }), false);
  }
});
