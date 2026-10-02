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

/**
 * What a user's computer costs on EC2, us-east-1 on-demand (checked
 * 2026-10-02): the instance (`t3a.medium`, infra/src/vm.ts), its gp3 volumes
 * (a 12 GiB root and the 20 GiB data volume, ec2-provider.ts) and its public
 * IPv4 address. Snapshots and traffic are small and left out.
 */
export const vmPricing = {
  instancePerHour: 0.0376,
  gp3PerGibMonth: 0.08,
  volumeGib: 12 + 20,
  publicIpv4PerHour: 0.005,
  hoursPerMonth: 730,
};

/** One VM-hour, all in. */
export const vmCostPerHour =
  vmPricing.instancePerHour +
  vmPricing.publicIpv4PerHour +
  (vmPricing.gp3PerGibMonth * vmPricing.volumeGib) / vmPricing.hoursPerMonth;
