/**
 * Job types shared between the service that queues them and the one that
 * runs them (docs/design.md §9).
 */

/** A front-of-house turn over a user's unconsumed input (§4, §16). */
export const frontTurnJob = {
  type: "front_turn",
  /** At most one queued turn per user, so a burst of messages becomes one turn. */
  dedupeKey: (userId: string) => `front_turn:${userId}`,
  /** How long a turn waits after the latest message for more to arrive. */
  debounceMs: 1_500,
} as const;

/** Provisioning a user's VM (§10, §15). Queued by account creation (M3); a script for now. */
export const provisionVmJob = {
  type: "provision_vm",
  /** One provisioning job queued per user at a time. */
  dedupeKey: (userId: string) => `provision_vm:${userId}`,
} as const;
