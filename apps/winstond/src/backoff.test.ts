import { describe, expect, test } from "bun:test";
import { backoffDelayMs } from "./backoff.ts";

describe("backoffDelayMs", () => {
  test("doubles from 1 s, capped at 30 s, with 50–100% jitter", () => {
    const top = (attempt: number) => backoffDelayMs(attempt, () => 1);
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(top)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(backoffDelayMs(3, () => 0)).toBe(4_000);
  });
});
