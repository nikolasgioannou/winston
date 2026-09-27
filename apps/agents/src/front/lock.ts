import type { Db } from "@winston/db/client";

/** First key of the two-key advisory lock, so front-turn locks never collide with other uses. */
const frontTurnLockSpace = 1;

/**
 * Runs `fn` holding the user's front-of-house lock, or returns "busy" at once
 * if another turn holds it (docs/design.md §1). It's a session-level advisory
 * lock on a reserved connection: a transaction-level one would mean holding a
 * transaction open across model calls. If the worker dies, its connection
 * closes and Postgres releases the lock.
 */
export async function withFrontTurnLock(
  db: Db,
  userId: string,
  fn: () => Promise<unknown>,
): Promise<"ran" | "busy"> {
  const connection = await db.$client.reserve();
  try {
    const [row] = await connection<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${frontTurnLockSpace}, hashtext(${userId})) as locked`;
    if (!row?.locked) return "busy";
    try {
      await fn();
    } finally {
      await connection`select pg_advisory_unlock(${frontTurnLockSpace}, hashtext(${userId}))`;
    }
    return "ran";
  } finally {
    connection.release();
  }
}
