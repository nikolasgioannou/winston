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

/**
 * Provisioning a user's VM (§10, §15). Queued by account creation (M3); a
 * script for now. Payload `{ replace: true }` rebuilds a VM that's already
 * running: a new instance on the same data volume (§17 `replace`).
 */
export const provisionVmJob = {
  type: "provision_vm",
  /** One provisioning job queued per user at a time. */
  dedupeKey: (userId: string) => `provision_vm:${userId}`,
} as const;

/**
 * Saving a file the user sent to their VM (§4, Media). Payload
 * `{ inboundItemId }`. The item stays `pending`, holding back the turn,
 * until this finishes; then it queues the turn.
 */
export const saveAttachmentJob = {
  type: "save_attachment",
  dedupeKey: (inboundItemId: string) => `save_attachment:${inboundItemId}`,
} as const;

/**
 * Transcribing a saved voice or video note (§4, Media). Payload
 * `{ inboundItemId }`. Queued by `save_attachment`; the item stays `pending`
 * until this releases it and queues the turn.
 */
export const transcribeVoiceJob = {
  type: "transcribe_voice",
  dedupeKey: (inboundItemId: string) => `transcribe_voice:${inboundItemId}`,
} as const;
