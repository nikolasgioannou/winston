import type { Db } from "@winston/db/client";

/**
 * The first key of each two-key advisory lock, so locks for different things
 * never collide.
 */
export const lockSpaces = {
  /** A user's front-of-house turn (§1). */
  frontTurn: 1,
  /** A background run's step (§9). */
  runStep: 2,
  /** One scheduler tick at a time across instances (§9). */
  scheduler: 3,
} as const;

/**
 * Runs `fn` holding the advisory lock `(space, hashtext(key))`, or returns
 * "busy" at once if someone else holds it. It's a session-level lock on a
 * reserved connection: a transaction-level one would mean holding a
 * transaction open across model calls. If the worker dies, its connection
 * closes and Postgres releases the lock.
 */
export async function withAdvisoryLock(
  db: Db,
  space: number,
  key: string,
  fn: () => Promise<unknown>,
): Promise<"ran" | "busy"> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${space}, hashtext(${key})) as locked`;
    if (!row?.locked) return "busy";
    try {
      await fn();
    } finally {
      await connection`select pg_advisory_unlock(${space}, hashtext(${key}))`;
    }
    return "ran";
  } finally {
    connection.release();
  }
}
