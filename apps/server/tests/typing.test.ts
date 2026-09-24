import assert from "node:assert/strict";
import { test } from "bun:test";
import { startTypingIndicator } from "../src/conversation/typing";

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    schedule: (delay: number, run: () => void) => {
      const key = ++id;
      timers.set(key, { at: now + delay, run });
      return () => {
        timers.delete(key);
      };
    },
    async advance(amount: number) {
      const target = now + amount;
      for (;;) {
        const next = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].run();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

test("typing waits for slow replies, refreshes serially and stops on completion or abort", async () => {
  const time = clock();
  const controller = new AbortController();
  const calls: AbortSignal[] = [];
  const send = (signal: AbortSignal) => {
    calls.push(signal);
    return Promise.resolve(true);
  };
  const immediate = startTypingIndicator({
    signal: controller.signal,
    send,
    schedule: time.schedule,
  });
  await time.advance(749);
  immediate();
  await time.advance(10_000);
  assert.equal(calls.length, 0);
  assert.equal(time.pending(), 0);
  startTypingIndicator({ signal: controller.signal, send, schedule: time.schedule });
  await time.advance(750);
  assert.equal(calls.length, 1);
  await time.advance(3500);
  assert.equal(calls.length, 2);
  controller.abort();
  assert.ok(calls.every((signal) => signal.aborted));
  await time.advance(60_000);
  assert.equal(calls.length, 2);
  assert.equal(time.pending(), 0);
});

test("failed, rate-limited, stalled and already-aborted indicators never keep refreshing", async () => {
  for (const result of [false, new Error("Synthetic failure")]) {
    const time = clock();
    let calls = 0;
    startTypingIndicator({
      signal: new AbortController().signal,
      schedule: time.schedule,
      send: () => {
        calls++;
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      },
    });
    await time.advance(120_000);
    assert.equal(calls, 1);
    assert.equal(time.pending(), 0);
  }
  const time = clock();
  const pending = Promise.withResolvers<boolean>();
  const signals: AbortSignal[] = [];
  startTypingIndicator({
    signal: new AbortController().signal,
    schedule: time.schedule,
    send: (signal) => {
      signals.push(signal);
      return pending.promise;
    },
  });
  await time.advance(120_000);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, true);
  pending.resolve(true);
  await Promise.resolve();
  assert.equal(time.pending(), 0);
  startTypingIndicator({
    signal: AbortSignal.abort(),
    schedule: time.schedule,
    send: () => {
      throw new Error("Must not send");
    },
  });
  assert.equal(time.pending(), 0);
});

test("healthy indicator refreshes still stop at the turn deadline", async () => {
  const time = clock();
  let calls = 0;
  startTypingIndicator({
    signal: new AbortController().signal,
    schedule: time.schedule,
    send: () => {
      calls++;
      return Promise.resolve(true);
    },
  });
  await time.advance(120_000);
  assert.equal(calls, 17);
  assert.equal(time.pending(), 0);
});
