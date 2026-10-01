import type { Db } from "@winston/db/client";
import { lockSpaces, withAdvisoryLock } from "../lock.ts";

/**
 * Runs `fn` holding the user's front-of-house lock, or returns "busy" at once
 * if another turn holds it (docs/design.md §1).
 */
export const withFrontTurnLock = (
  db: Db,
  userId: string,
  fn: () => Promise<unknown>,
) => withAdvisoryLock(db, lockSpaces.frontTurn, userId, fn);
