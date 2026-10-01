/**
 * Gmail push notifications (docs/design.md §3, How change notifications
 * arrive): Pub/Sub delivers "something changed for this address" with an
 * OIDC token. Once the token checks out, each live mail connection for the
 * address gets one queued sync (deduplicated, so a burst is one sync), and
 * the push is acknowledged at once. Unknown addresses are acknowledged and
 * ignored, so Pub/Sub doesn't retry them.
 */
import { enqueue } from "@winston/db/queue";
import { connections } from "@winston/db/schema";
import { syncConnectionJob } from "@winston/domain/jobs";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { ApiDeps, ApiEnv } from "../app.ts";
import { verifyPushToken, type PushIdentity } from "../google-oidc.ts";

const pushBody = z.object({
  message: z.object({ data: z.string(), messageId: z.string().optional() }),
  subscription: z.string().optional(),
});

const notification = z.object({
  emailAddress: z.string(),
  historyId: z.union([z.string(), z.number()]),
});

export function gmailWebhookRoutes(
  deps: Pick<ApiDeps, "db"> & {
    /** Unset where Gmail push isn't configured: the route then refuses everything. */
    push: PushIdentity | undefined;
    keys?: JWTVerifyGetKey;
  },
) {
  return new Hono<ApiEnv>().post("/", async (c) => {
    const logger = c.get("logger");
    if (!deps.push) return c.json({ error: "not_configured" }, 503);
    const verified = await verifyPushToken(
      c.req.header("Authorization"),
      deps.push,
      deps.keys,
    );
    if (!verified.ok) {
      logger.warn({ reason: verified.reason }, "rejected a Gmail push");
      return c.json({ error: "unauthorized" }, 401);
    }
    const body = pushBody.safeParse(await c.req.json().catch(() => undefined));
    const data = body.success ? decode(body.data.message.data) : undefined;
    if (!data?.success) {
      // Malformed pushes would only be retried; acknowledge and log them.
      logger.warn("ignoring a malformed Gmail push");
      return c.body(null, 204);
    }
    const address = data.data.emailAddress.trim().toLowerCase();
    const matches = await deps.db
      .select({ id: connections.id, userId: connections.userId })
      .from(connections)
      .where(
        and(
          eq(connections.domain, "mail"),
          eq(connections.externalEmail, address),
          ne(connections.status, "disconnected"),
        ),
      );
    for (const connection of matches)
      await enqueue(deps.db, syncConnectionJob.type, {
        userId: connection.userId,
        payload: { connectionId: connection.id },
        dedupeKey: syncConnectionJob.dedupeKey(connection.id),
      });
    logger.info(
      { connections: matches.length, historyId: String(data.data.historyId) },
      "Gmail push",
    );
    return c.body(null, 204);
  });
}

/** The notification inside a push: base64 JSON with the address and history id. */
function decode(data: string) {
  try {
    return notification.safeParse(
      JSON.parse(Buffer.from(data, "base64").toString()),
    );
  } catch {
    return undefined;
  }
}
