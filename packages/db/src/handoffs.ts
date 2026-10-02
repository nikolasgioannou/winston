/**
 * Handoff links (docs/design.md §5 Browser handoff, §17): a random token,
 * stored hashed, that opens a live view of one browser window. It works
 * once, within 15 minutes; the page that opens it gets a secret of its own
 * to reconnect with, so a dropped connection doesn't need the link again.
 * The handoff ends when its run carries on (or is cancelled).
 */
import { generateToken, hashToken, tokenMatches } from "@winston/shared/tokens";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { handoffs, runs } from "./schema/index.ts";

export const handoffConnectMs = 15 * 60_000;

/** The page a handoff token opens on the site. */
export function handoffLink(webPublicUrl: string, token: string) {
  return new URL(`/t/${token}`, webPublicUrl).href;
}

/**
 * Makes a link for a run's window. An earlier link of the run that nobody
 * opened stops working (a fresh link replaces it).
 */
export async function createHandoff(
  db: DbOrTx,
  handoff: {
    runId: string;
    userId: string;
    windowId: string;
    targetId: string;
    reason: string;
  },
) {
  await db
    .update(handoffs)
    .set({ status: "expired", resolvedAt: sql`now()` })
    .where(and(eq(handoffs.runId, handoff.runId), eq(handoffs.status, "open")));
  const token = generateToken();
  const [row] = await db
    .insert(handoffs)
    .values({
      ...handoff,
      tokenHash: hashToken(token),
      connectDeadline: sql`now() + ${handoffConnectMs} * interval '1 millisecond'`,
    })
    .returning({ id: handoffs.id });
  if (!row) throw new Error("No handoff row");
  return { id: row.id, token };
}

export type HandoffRow = typeof handoffs.$inferSelect;

export type ConnectResult =
  | { ok: true; handoff: HandoffRow; viewerSecret: string }
  | { ok: false; reason: "unknown" | "used" | "expired" | "ended" };

/**
 * The live-view page opening a link: valid once, before its deadline. Uses
 * the token up and hands the page its own secret for reconnecting.
 */
export async function connectHandoff(
  db: DbOrTx,
  token: string,
): Promise<ConnectResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(handoffs)
      .where(eq(handoffs.tokenHash, hashToken(token)))
      .for("update");
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status === "connected") return { ok: false, reason: "used" };
    if (row.status !== "open")
      return {
        ok: false,
        reason: row.status === "expired" ? "expired" : "ended",
      };
    if (row.connectDeadline.getTime() <= Date.now()) {
      await tx
        .update(handoffs)
        .set({ status: "expired", resolvedAt: sql`now()` })
        .where(eq(handoffs.id, row.id));
      return { ok: false, reason: "expired" };
    }
    const viewerSecret = generateToken();
    const [connected] = await tx
      .update(handoffs)
      .set({ status: "connected", viewerSecretHash: hashToken(viewerSecret) })
      .where(eq(handoffs.id, row.id))
      .returning();
    if (!connected) throw new Error("No handoff row");
    return { ok: true, handoff: connected, viewerSecret };
  });
}

/** The page coming back after a drop, with the secret it was given. */
export async function reconnectHandoff(
  db: DbOrTx,
  handoffId: string,
  viewerSecret: string,
) {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.id, handoffId), eq(handoffs.status, "connected")));
  if (
    !row?.viewerSecretHash ||
    !tokenMatches(viewerSecret, row.viewerSecretHash)
  )
    return undefined;
  return row;
}

/** Ends a run's live handoffs (it carried on, or was cancelled). Returns their ids. */
export async function resolveHandoffs(db: DbOrTx, runId: string) {
  const ended = await db
    .update(handoffs)
    .set({ status: "resolved", resolvedAt: sql`now()` })
    .where(
      and(
        eq(handoffs.runId, runId),
        inArray(handoffs.status, ["open", "connected"]),
      ),
    )
    .returning({ id: handoffs.id });
  return ended.map((row) => row.id);
}

/**
 * Ends the front of house's live handoffs: they last until the user writes
 * again, since the front of house hears "done" as their next message.
 */
export async function resolveFrontHandoffs(db: DbOrTx, userId: string) {
  const ended = await db
    .update(handoffs)
    .set({ status: "resolved", resolvedAt: sql`now()` })
    .where(
      and(
        eq(handoffs.userId, userId),
        inArray(handoffs.status, ["open", "connected"]),
        inArray(
          handoffs.runId,
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.userId, userId), eq(runs.kind, "front"))),
        ),
      ),
    )
    .returning({ id: handoffs.id });
  return ended.map((row) => row.id);
}

/** The window of a run's latest handoff, for a fresh link. */
export async function latestHandoff(db: DbOrTx, runId: string) {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(eq(handoffs.runId, runId))
    .orderBy(sql`${handoffs.createdAt} desc`)
    .limit(1);
  return row;
}
