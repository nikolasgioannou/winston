import { describe, expect, test } from "bun:test";
import { computeCostUsd } from "./pricing.ts";

// Cases taken from real `bun run model:smoke` calls, where OpenRouter reported the cost.
describe("computeCostUsd", () => {
  test("Sonnet 5: a cache write, then a cache read", () => {
    const write = {
      inputTokens: 5177,
      cachedTokens: 0,
      cacheWriteTokens: 5158,
      outputTokens: 9,
    };
    const read = {
      inputTokens: 5177,
      cachedTokens: 5158,
      cacheWriteTokens: 0,
      outputTokens: 9,
    };
    expect(computeCostUsd("anthropic/claude-sonnet-5", write)).toBeCloseTo(
      0.013023,
      6,
    );
    expect(computeCostUsd("anthropic/claude-sonnet-5", read)).toBeCloseTo(
      0.00116,
      6,
    );
  });

  test("Opus 5.5: a cache write, then a cache read", () => {
    const write = {
      inputTokens: 5179,
      cachedTokens: 0,
      cacheWriteTokens: 5158,
      outputTokens: 104,
    };
    const read = {
      inputTokens: 5179,
      cachedTokens: 5158,
      cacheWriteTokens: 0,
      outputTokens: 113,
    };
    expect(computeCostUsd("anthropic/claude-opus-5.5", write)).toBeCloseTo(
      0.027954,
      6,
    );
    expect(computeCostUsd("anthropic/claude-opus-5.5", read)).toBeCloseTo(
      0.003376,
      6,
    );
  });
});
