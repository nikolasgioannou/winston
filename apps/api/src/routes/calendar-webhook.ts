/**
 * Google Calendar push notifications (docs/design.md §3): a channel says
 * "this calendar changed" with its id and token. A known channel with the
 * right token queues one sync of its connection (deduplicated); the first
 * message on a new channel (`sync`) only confirms it. Unknown channels
 * (stopped ones still draining) are acknowledged and ignored.
 */
import { timingSafeEqual } from "node:crypto";
import { enqueue } from "@winston/db/queue";
import { calendarChannels, connections } from "@winston/db/schema";
import { syncConnectionJob } from "@winston/domain/jobs";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiDeps, ApiEnv } from "../app.ts";

const sha256 = (text: string) =>
  Buffer.from(new Bun.CryptoHasher("sha256").update(text).digest());

export function calendarWebhookRoutes(deps: Pick<ApiDeps, "db">) {
  return new Hono<ApiEnv>().post("/", async (c) => {
    const logger = c.get("logger");
    const channelId = c.req.header("X-Goog-Channel-ID");
    const token = c.req.header("X-Goog-Channel-Token") ?? "";
    const state = c.req.header("X-Goog-Resource-State");
    if (!channelId) return c.json({ error: "unauthorized" }, 401);
    const [channel] = await deps.db
      .select({
        connectionId: calendarChannels.connectionId,
        tokenHash: calendarChannels.tokenHash,
        userId: connections.userId,
      })
      .from(calendarChannels)
      .innerJoin(connections, eq(connections.id, calendarChannels.connectionId))
      .where(
        and(
          eq(calendarChannels.id, channelId),
          ne(connections.status, "disconnected"),
        ),
      );
    if (!channel) return c.body(null, 204);
    const expected = Buffer.from(channel.tokenHash, "hex");
    const given = sha256(token);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      logger.warn({ channelId }, "rejected a calendar push with a wrong token");
      return c.json({ error: "unauthorized" }, 401);
    }
    if (state === "sync") return c.body(null, 204);
    await enqueue(deps.db, syncConnectionJob.type, {
      userId: channel.userId,
      payload: { connectionId: channel.connectionId },
      dedupeKey: syncConnectionJob.dedupeKey(channel.connectionId),
    });
    logger.info({ channelId, state }, "calendar push");
    return c.body(null, 204);
  });
}
