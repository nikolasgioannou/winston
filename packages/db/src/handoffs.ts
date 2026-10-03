/**
 * Handoffs (docs/design.md §5 Browser handoff, §17): a browser window handed
 * to the user, the record of who has control, why, and when it ended. The
 * user watches and works in it on the signed-in browser page
 * (`/browser?window=…`), so its link holds nothing secret. A handoff ends
 * when its run carries on (or is cancelled), or when the user writes to the
 * front of house after it handed over.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { handoffs, runs } from "./schema/index.ts";

/** The signed-in browser page, open at a window when there's one. */
export function browserLink(webPublicUrl: string, windowId?: string) {
  const url = new URL("/browser", webPublicUrl);
  if (windowId) url.searchParams.set("window", windowId);
  return url.href;
}

/**
 * The site's Telegram sign-in for a page on it: a login button opens this
 * with the tapper's signed Telegram identity added, and lands on `link`
 * signed in (docs/design.md §13).
 */
export function telegramLoginUrl(webPublicUrl: string, link: string) {
  const target = new URL(link);
  const url = new URL("/auth/telegram", webPublicUrl);
  url.searchParams.set("next", `${target.pathname}${target.search}`);
  return url.href;
}

/** Records a run handing its window to the user; an earlier open one of the run ends. */
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
  await resolveHandoffs(db, handoff.runId);
  const [row] = await db
    .insert(handoffs)
    .values(handoff)
    .returning({ id: handoffs.id });
  if (!row) throw new Error("No handoff row");
  return { id: row.id };
}

export type HandoffRow = typeof handoffs.$inferSelect;

/** Ends a run's open handoffs (it carried on, or was cancelled). Returns their ids. */
export async function resolveHandoffs(db: DbOrTx, runId: string) {
  const ended = await db
    .update(handoffs)
    .set({ status: "resolved", resolvedAt: sql`now()` })
    .where(and(eq(handoffs.runId, runId), eq(handoffs.status, "open")))
    .returning({ id: handoffs.id });
  return ended.map((row) => row.id);
}

/**
 * Ends the front of house's open handoffs: they last until the user writes
 * again, since the front of house hears "done" as their next message. The
 * page keeps showing the window; only control goes back. Returns them with
 * their windows.
 */
export async function resolveFrontHandoffs(db: DbOrTx, userId: string) {
  const ended = await db
    .update(handoffs)
    .set({ status: "resolved", resolvedAt: sql`now()` })
    .where(
      and(
        eq(handoffs.userId, userId),
        eq(handoffs.status, "open"),
        inArray(
          handoffs.runId,
          db
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.userId, userId), eq(runs.kind, "front"))),
        ),
      ),
    )
    .returning({ id: handoffs.id, windowId: handoffs.windowId });
  return ended;
}

/** A run's latest handoff, for its window. */
export async function latestHandoff(db: DbOrTx, runId: string) {
  const [row] = await db
    .select()
    .from(handoffs)
    .where(eq(handoffs.runId, runId))
    .orderBy(sql`${handoffs.createdAt} desc`)
    .limit(1);
  return row;
}

/** The user's open handoffs, by window: what each is for. */
export async function openHandoffs(db: DbOrTx, userId: string) {
  return db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.userId, userId), eq(handoffs.status, "open")))
    .orderBy(sql`${handoffs.createdAt} desc`);
}
