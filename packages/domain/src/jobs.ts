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
 * One step of a background run (§1, §9): a model call and its tools, then
 * the next step is queued. Any worker can take any step, since the run's
 * state lives in `run_messages` between steps.
 */
export const runStepJob = {
  type: "run_step",
  /** One queued step per run. */
  dedupeKey: (runId: string) => `run_step:${runId}`,
  /** Attempts before the run fails: about 20 minutes of backoff, enough to ride out an outage. */
  maxAttempts: 12,
} as const;

/**
 * A schedule's occurrence came (§3, §17 Scheduler loop). The payload names
 * the occurrence, so a duplicate job for one the trigger has moved past does
 * nothing.
 */
export const fireScheduleJob = {
  type: "fire_schedule",
  dedupeKey: (triggerId: string, occurrence: string) =>
    `fire_schedule:${triggerId}:${occurrence}`,
} as const;

/** A trigger passed its `expires_at`: it expires, maybe with an `on_expire` run. */
export const expireTriggerJob = {
  type: "expire_trigger",
  dedupeKey: (triggerId: string) => `expire_trigger:${triggerId}`,
} as const;

/** A subscription's batch of events is due to fire (§3: 30 s after its first event). */
export const fireTriggerBatchJob = {
  type: "fire_trigger_batch",
  dedupeKey: (batchId: number) => `fire_trigger_batch:${String(batchId)}`,
} as const;

/**
 * Recomputing a `calendar.event.starting` subscription's timers from the
 * upcoming week of events (§3, abstractions): on create or update, after a
 * calendar sync, and on reconciliation (which extends the horizon).
 */
export const refreshTimersJob = {
  type: "refresh_timers",
  dedupeKey: (triggerId: string) => `refresh_timers:${triggerId}`,
} as const;

/** Stored events to match against subscriptions, when they weren't stored by `agents` (system events from the site). */
export const matchEventsJob = { type: "match_events" } as const;

/** A materialized `calendar.event.starting` timer came due (§3, abstractions). */
export const fireDerivedTimerJob = {
  type: "fire_derived_timer",
  dedupeKey: (timerId: number) => `fire_derived_timer:${String(timerId)}`,
} as const;

/**
 * Starting or renewing a connection's watch on its provider's change feed
 * (§3): queued when an account connects and by the renewal sweep.
 */
export const watchConnectionJob = {
  type: "watch_connection",
  dedupeKey: (connectionId: string) => `watch_connection:${connectionId}`,
} as const;

/**
 * Syncing a connection's changes into events (§17 event pipeline): queued by
 * push notifications and the reconciliation sweep. One queued per
 * connection, so a burst of notifications is one sync.
 */
export const syncConnectionJob = {
  type: "sync_connection",
  dedupeKey: (connectionId: string) => `sync_connection:${connectionId}`,
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
/** Moves a VM onto the current image (a new instance, same data volume). */
export const rollVmJob = {
  type: "roll_vm",
  dedupeKey: (userId: string) => `roll_vm:${userId}`,
  maxAttempts: 1,
} as const;

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
