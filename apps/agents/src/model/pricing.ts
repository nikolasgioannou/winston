import type { modelProfiles } from "./gateway.ts";

type ModelId = (typeof modelProfiles)[keyof typeof modelProfiles]["model"];

/**
 * OpenRouter prices in USD per million tokens (checked 2026-09-27). Only a
 * fallback: the logged cost is OpenRouter's reported charge when present, and
 * a mismatch with these rates is logged as a warning. Cache writes are the
 * 5-minute rate, the only TTL Winston uses.
 */
export const pricing: Record<
  ModelId,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  "anthropic/claude-sonnet-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "anthropic/claude-opus-5.5": {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5,
  },
};

/** Cost from token counts. `inputTokens` includes cached and cache-write tokens. */
export function computeCostUsd(
  model: ModelId,
  usage: {
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  },
) {
  const rates = pricing[model];
  const uncached =
    usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens;
  return (
    (uncached * rates.input +
      usage.cachedTokens * rates.cacheRead +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.outputTokens * rates.output) /
    1_000_000
  );
}
