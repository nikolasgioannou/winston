/**
 * The trigger lifecycle (docs/design.md §3, Trigger lifecycle), as pure
 * functions: the scheduler, the matcher and the CLI all ask the same
 * questions (is it due, what happens after it fires, has it expired), so the
 * answers live in one place.
 *
 * Cron is evaluated with croner in the user's time zone. Across DST it runs
 * once a day either way: a time the clocks skip runs an hour later (02:30
 * becomes 03:30 EDT on the spring-forward day), and a repeated time runs at
 * its first occurrence.
 */
import { Cron } from "croner";

export const triggerKinds = ["schedule", "subscription"] as const;
export type TriggerKind = (typeof triggerKinds)[number];

export const triggerStatuses = [
  "active",
  "exhausted",
  "expired",
  "deleted",
] as const;
export type TriggerStatus = (typeof triggerStatuses)[number];

/** What the lifecycle rules need to know about a trigger. */
export interface TriggerLifecycle {
  kind: TriggerKind;
  status: TriggerStatus;
  /** A one-off schedule's time. */
  at: Date | null;
  /** A recurring schedule's 5-field cron, in the user's time zone. */
  cron: string | null;
  /** Null for unlimited. */
  maxFires: number | null;
  fireCount: number;
  expiresAt: Date | null;
  onExpireNote: string | null;
  nextFireAt: Date | null;
}

/** Why a cron pattern isn't usable, or undefined if it is. */
export function cronProblem(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5)
    return `"${cron}" has ${String(fields.length)} fields; use 5: minute hour day-of-month month day-of-week, like "0 8 * * 1-5".`;
  try {
    new Cron(cron, { paused: true });
    return undefined;
  } catch (error) {
    return `"${cron}" isn't a valid cron pattern: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * When a schedule fires next, strictly after `after`: a one-off's `at` if
 * it's still ahead, or the cron's next occurrence in `timeZone`. Null when it
 * won't fire again (or for a subscription, which fires on events).
 */
export function nextFireAt(
  trigger: Pick<TriggerLifecycle, "kind" | "at" | "cron">,
  after: Date,
  timeZone: string,
): Date | null {
  if (trigger.kind !== "schedule") return null;
  if (trigger.at) return trigger.at > after ? trigger.at : null;
  if (!trigger.cron) return null;
  return (
    new Cron(trigger.cron, { timezone: timeZone, paused: true }).nextRun(
      after,
    ) ?? null
  );
}

/** Whether a schedule is due at `now`: active, its time come, and not past its expiry. */
export function isDue(trigger: TriggerLifecycle, now: Date) {
  return (
    trigger.status === "active" &&
    trigger.nextFireAt !== null &&
    trigger.nextFireAt <= now &&
    (trigger.expiresAt === null || trigger.nextFireAt < trigger.expiresAt)
  );
}

/** Whether it may still fire: active, under `max_fires`, and not expired at `now`. */
export function canFire(trigger: TriggerLifecycle, now: Date) {
  return (
    trigger.status === "active" &&
    (trigger.maxFires === null || trigger.fireCount < trigger.maxFires) &&
    (trigger.expiresAt === null || now < trigger.expiresAt)
  );
}

/**
 * The trigger after it fires at `firedAt`: one more fire, `exhausted` once
 * it reaches `max_fires` (or a one-off has nothing left), and a schedule's
 * next time.
 */
export function afterFire(
  trigger: TriggerLifecycle,
  firedAt: Date,
  timeZone: string,
): Pick<TriggerLifecycle, "fireCount" | "status" | "nextFireAt"> {
  const fireCount = trigger.fireCount + 1;
  const next =
    trigger.kind === "schedule" ? nextFireAt(trigger, firedAt, timeZone) : null;
  const exhausted =
    (trigger.maxFires !== null && fireCount >= trigger.maxFires) ||
    (trigger.kind === "schedule" && next === null);
  return {
    fireCount,
    status: exhausted ? "exhausted" : trigger.status,
    nextFireAt: exhausted ? null : next,
  };
}

/**
 * What expiry does at `now`, or undefined if it isn't expiring: the trigger
 * becomes `expired`, and its `on_expire` run is due if it hadn't reached
 * `max_fires` (that's how Winston notices something didn't happen).
 */
export function expire(
  trigger: TriggerLifecycle,
  now: Date,
): { status: "expired"; runOnExpire: boolean } | undefined {
  if (
    trigger.status !== "active" ||
    trigger.expiresAt === null ||
    now < trigger.expiresAt
  )
    return undefined;
  return {
    status: "expired",
    runOnExpire:
      trigger.onExpireNote !== null &&
      (trigger.maxFires === null || trigger.fireCount < trigger.maxFires),
  };
}
