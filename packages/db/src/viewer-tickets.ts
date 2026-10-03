/**
 * Viewer tickets (docs/design.md §5, §13): how the signed-in browser page
 * signs its socket in to the gateway. The page's own server issues one for
 * the session's user; the gateway uses it up. A dropped socket gets a fresh
 * one the same way.
 */
import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, eq, gt, lte } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { viewerTickets } from "./schema/index.ts";

/** How long a ticket works: long enough to open a socket, no more. */
export const viewerTicketMs = 60_000;

/** A ticket for `userId`'s browser page; expired ones are deleted along the way. */
export async function issueViewerTicket(
  db: DbOrTx,
  userId: string,
  now = new Date(),
) {
  const token = generateToken();
  await db.delete(viewerTickets).where(lte(viewerTickets.expiresAt, now));
  await db.insert(viewerTickets).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(now.getTime() + viewerTicketMs),
  });
  return token;
}

/** Uses a ticket up: its user, or undefined if it's unknown, used or expired. */
export async function useViewerTicket(
  db: DbOrTx,
  token: string,
  now = new Date(),
) {
  const [used] = await db
    .delete(viewerTickets)
    .where(
      and(
        eq(viewerTickets.tokenHash, hashToken(token)),
        gt(viewerTickets.expiresAt, now),
      ),
    )
    .returning({ userId: viewerTickets.userId });
  return used?.userId;
}
