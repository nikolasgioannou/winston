import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createTestIds, ScriptedAdapter, TestClock } from "../../src";

async function replayScenario() {
  const clock = new TestClock("2026-01-01T00:00:00.000Z");
  const nextId = createTestIds("task");
  const model = new ScriptedAdapter<string, string>([{ value: "read calendar" }]);
  const tool = new ScriptedAdapter<string, string>([
    { error: new Error("temporarily unavailable") },
    { value: "synthetic appointment" },
  ]);
  const provider = new ScriptedAdapter<string, string>([{ value: "delivered" }]);
  const events: { id: string; at: string; state: string }[] = [];
  const action = await model.execute("What is next?");
  const id = nextId();

  try {
    await tool.execute(action);
  } catch {
    events.push({ id, at: clock.now().toISOString(), state: "waiting" });
  }

  clock.advance(1_000);

  const result = await tool.execute(action);
  const state = await provider.execute(result);

  events.push({ id, at: clock.now().toISOString(), state });
  model.assertExhausted();
  tool.assertExhausted();
  provider.assertExhausted();

  return { events, calls: tool.calls };
}

test("clock advancement and a tool failure produce a repeatable scenario", async () => {
  const first = await replayScenario();
  const second = await replayScenario();

  expect(second).toEqual(first);
  expect(first.events).toEqual([
    { id: "task-0001", at: "2026-01-01T00:00:00.000Z", state: "waiting" },
    { id: "task-0001", at: "2026-01-01T00:00:01.000Z", state: "delivered" },
  ]);
  expect(first.calls).toEqual(["read calendar", "read calendar"]);
});

test("clocks reject invalid advancement and cannot be mutated through returned dates", () => {
  const clock = new TestClock("2026-01-01T00:00:00Z");

  clock.now().setFullYear(1999);

  expect(clock.now().getUTCFullYear()).toBe(2026);
  expect(() => {
    clock.advance(-1);
  }).toThrow(RangeError);
  expect(() => {
    clock.advance(Number.NaN);
  }).toThrow(RangeError);
  expect(() => {
    clock.advance(0.5);
  }).toThrow(RangeError);
  expect(() => new TestClock("invalid")).toThrow(RangeError);
});

test("scripted adapters expose unexpected and missing calls", async () => {
  const adapter = new ScriptedAdapter<string, string>([{ value: "response" }]);

  expect(() => {
    adapter.assertExhausted();
  }).toThrow("not consumed");
  expect(await adapter.execute("request")).toBe("response");
  await assert.rejects(adapter.execute("unexpected"), /no scripted outcome/);
});

test("IDs and scripted call records are isolated between tests", async () => {
  const first = createTestIds();
  const second = createTestIds();
  const adapter = new ScriptedAdapter<{ text: string }, string>([{ value: "response" }]);
  const input = { text: "original" };

  await adapter.execute(input);
  input.text = "changed";

  expect(adapter.calls).toEqual([{ text: "original" }]);
  expect(first()).toBe("test-0001");
  expect(first()).toBe("test-0002");
  expect(second()).toBe("test-0001");
});
