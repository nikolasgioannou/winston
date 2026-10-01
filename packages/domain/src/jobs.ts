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
 * Provisioning a user's VM (§10, §15). Queued when a user's VM is requested
 * (at sign-up), by a setup failure's automatic retry, and by the retry
 * button. Payload `{ replace: true }` rebuilds a VM that's already running: a
 * new instance on the same data volume (§17 `replace`).
 */
export const provisionVmJob = {
  type: "provision_vm",
  /** One provisioning job queued per user at a time. */
  dedupeKey: (userId: string) => `provision_vm:${userId}`,
  /** Attempts per job; when the last one fails, the VM's setup has failed. */
  maxAttempts: 3,
  /** Failed setups retried automatically before the user is asked to retry. */
  autoRetries: 3,
  /** The wait before an automatic retry, times the failure count. */
  autoRetryDelayMs: 30_000,
} as const;

/**
 * Restoring a user's VM from its latest data-volume snapshot (§10, Backups;
 * docs/runbooks/vm-recovery.md). Queued by hand with `bun run prod
 * vm:restore <email>`. One attempt: a half-done restore needs a look, not a
 * blind retry.
 */
export const restoreVmJob = {
  type: "restore_vm",
  dedupeKey: (userId: string) => `restore_vm:${userId}`,
  maxAttempts: 1,
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

/**
 * Dealing with a disconnected connection's grant (§12a): revoke it with
 * Google, unless another of the user's connections uses the same Google
 * account (revoking one grant revokes them all), then delete the token.
 * Payload `{ connectionId }`. Runs in `agents`, which can decrypt tokens.
 */
export const revokeConnectionTokenJob = {
  type: "revoke_connection_token",
  dedupeKey: (connectionId: string) =>
    `revoke_connection_token:${connectionId}`,
} as const;

/**
 * Deleting an account and everything in it (§13, §17). Payload `{ userId }`,
 * and deliberately no job `user_id`: deleting the user cascades to their jobs,
 * and this one must outlive that. Idempotent, so a retry finishes the job.
 */
export const deleteUserJob = {
  type: "delete_user",
  dedupeKey: (userId: string) => `delete_user:${userId}`,
} as const;
