import { describe, expect, test } from "bun:test";
import { createLogger } from "@winston/shared/logger";
import { startTyping, typingIntervalMs } from "./typing.ts";

/** Timers you advance by hand. */
function fakeTimers() {
  let tick: (() => void) | undefined;
  let interval = 0;
  return {
    timers: {
      setInterval: (callback: () => void, ms: number) => {
        tick = callback;
        interval = ms;
        return 1;
      },
      clearInterval: () => {
        tick = undefined;
      },
    },
    advance(ms: number) {
      for (let elapsed = interval; elapsed <= ms; elapsed += interval) tick?.();
    },
  };
}

const logs: Record<string, unknown>[] = [];
const logger = createLogger("agents-test", {
  pretty: false,
  destination: {
    write: (line: string) =>
      logs.push(JSON.parse(line) as Record<string, unknown>),
  },
});

describe("startTyping", () => {
  test("sends at once, repeats every interval, and stops for good", () => {
    const clock = fakeTimers();
    let sends = 0;
    const typing = startTyping(
      () => {
        sends += 1;
        return Promise.resolve();
      },
      logger,
      clock.timers,
    );
    expect(sends).toBe(1);
    clock.advance(typingIntervalMs * 3);
    expect(sends).toBe(4);
    typing.stop();
    typing.stop();
    clock.advance(typingIntervalMs * 3);
    expect(sends).toBe(4);
  });

  test("a failing send is logged, never thrown, and doesn't stop the repeats", async () => {
    const clock = fakeTimers();
    let sends = 0;
    const typing = startTyping(
      () => {
        sends += 1;
        return Promise.reject(new Error("Telegram is down"));
      },
      logger,
      clock.timers,
    );
    clock.advance(typingIntervalMs);
    await Promise.resolve();
    expect(sends).toBe(2);
    expect(
      logs.filter((line) => line.msg === "sending the typing indicator failed"),
    ).toHaveLength(2);
    typing.stop();
  });
});
