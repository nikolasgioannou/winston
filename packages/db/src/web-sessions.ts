import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, eq, gt, lte } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { webSessions } from "./schema/index.ts";

/** How long a sign-in lasts. */
export const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/**
 * Starts a session for a signed-in user. Returns the raw token, for the
 * cookie, once; only its hash is stored. Expired sessions are deleted along
 * the way, so they don't pile up without a scheduled cleanup.
 */
export async function createSession(
  db: DbOrTx,
  userId: string,
  now = new Date(),
) {
  await db.delete(webSessions).where(lte(webSessions.expiresAt, now));
  const token = generateToken();
  const [session] = await db
    .insert(webSessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
    })
    .returning();
  if (!session) throw new Error("Creating a session returned no row.");
  return { token, session };
}

/**
 * The session a cookie's token belongs to, if it hasn't expired. Looked up
 * by the token's hash, so the raw token is never stored or compared.
 */
export async function findSession(db: DbOrTx, token: string, now = new Date()) {
  const [session] = await db
    .select()
    .from(webSessions)
    .where(
      and(
        eq(webSessions.tokenHash, hashToken(token)),
        gt(webSessions.expiresAt, now),
      ),
    );
  return session;
}

/** Ends a session (sign-out). */
export async function deleteSession(db: DbOrTx, token: string) {
  await db
    .delete(webSessions)
    .where(eq(webSessions.tokenHash, hashToken(token)));
}
