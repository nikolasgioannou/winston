/** Reconnect delays: 1 s doubling to 30 s (docs/design.md §15). */
export const backoffBaseMs = 1_000;
export const backoffMaxMs = 30_000;

/**
 * The delay before reconnect attempt `attempt` (from 0): exponential,
 * capped, with jitter (50–100% of the delay) so VMs don't reconnect in
 * lockstep after a gateway restart.
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
  baseMs = backoffBaseMs,
  maxMs = backoffMaxMs,
) {
  const delay = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(delay * (0.5 + random() * 0.5));
}
