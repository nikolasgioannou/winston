import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import type { Job } from "@winston/db/queue";
import { calendarChannels, connections } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { asc, eq } from "drizzle-orm";
import { watchConnectionHandler, watchStopper } from "./watch.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const address = "https://api.runwinston.com/webhooks/calendar";
const day = 86_400_000;

/** Google Calendar standing in: the calendar list, and every watch and stop asked for. */
function calendarApi(
  calendars: { id: string; selected?: boolean; primary?: boolean }[],
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let next = 0;
  const fetch = ((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/token"))
      return Promise.resolve(
        Response.json({ access_token: "access", expires_in: 3600 }),
      );
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : {};
    calls.push({ path, body });
    if (path.endsWith("/calendarList"))
      return Promise.resolve(
        Response.json({
          items: calendars.map((c) => ({
            accessRole: "owner",
            selected: true,
            ...c,
          })),
        }),
      );
    if (path.endsWith("/events/watch")) {
      next += 1;
      return Promise.resolve(
        Response.json({
          resourceId: `res-${String(next)}`,
          expiration: String(Date.now() + 7 * day - next * 1000),
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const watch = (
  tx: DbOrTx,
  connectionId: string,
  fetch: typeof globalThis.fetch,
) =>
  watchConnectionHandler({
    accessToken: () => Promise.resolve("access"),
    gmailTopic: undefined,
    calendarAddress: address,
    fetch,
  })({
    job: { payload: { connectionId } } as unknown as Job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });

const channelsOf = (tx: DbOrTx, connectionId: string) =>
  tx
    .select()
    .from(calendarChannels)
    .where(eq(calendarChannels.connectionId, connectionId))
    .orderBy(asc(calendarChannels.calendarId));

describe("calendar channels", () => {
  test("one channel per listed calendar, with a token whose hash is kept, and the soonest end on the connection", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
      });
      const api = calendarApi([
        { id: "me@example.com", primary: true },
        { id: "family", selected: true },
        { id: "holidays", selected: false },
      ]);
      await watch(tx, connection.id, api.fetch);
      const watches = api.calls.filter((c) => c.path.endsWith("/events/watch"));
      expect(watches.map((c) => c.path)).toEqual([
        "/calendar/v3/calendars/me%40example.com/events/watch",
        "/calendar/v3/calendars/family/events/watch",
      ]);
      expect(watches[0]?.body).toMatchObject({
        type: "web_hook",
        address,
        params: { ttl: String(7 * 24 * 3600) },
      });
      const rows = await channelsOf(tx, connection.id);
      expect(rows.map((r) => r.calendarId)).toEqual([
        "family",
        "me@example.com",
      ]);
      const token = watches[0]?.body.token as string;
      const stored = rows.find((r) => r.calendarId === "me@example.com");
      expect(stored?.tokenHash).toBe(
        new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      );
      const [row] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, connection.id));
      expect(row?.watchExpiresAt?.getTime()).toBe(
        Math.min(...rows.map((r) => r.expiresAt.getTime())),
      );
    });
  });

  test("renewal opens the new channel before stopping the old one; calendars no longer listed are stopped", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
      });
      const old = (id: string, calendarId: string, ends: number) => ({
        id,
        connectionId: connection.id,
        calendarId,
        resourceId: `res-${id}`,
        tokenHash: "x",
        expiresAt: new Date(Date.now() + ends),
      });
      await tx
        .insert(calendarChannels)
        .values([
          old("ending", "me@example.com", day),
          old("fresh", "family", 5 * day),
          old("dropped", "holidays", 5 * day),
        ]);
      const api = calendarApi([
        { id: "me@example.com", primary: true },
        { id: "family", selected: true },
      ]);
      await watch(tx, connection.id, api.fetch);
      const sequence = api.calls
        .filter((c) => !c.path.endsWith("/calendarList"))
        .map((c) =>
          c.path.endsWith("/stop") ? `stop ${String(c.body.id)}` : "watch me",
        );
      expect(sequence).toEqual(["watch me", "stop ending", "stop dropped"]);
      expect((await channelsOf(tx, connection.id)).map((r) => r.id)).toContain(
        "fresh",
      );
      expect(await channelsOf(tx, connection.id)).toHaveLength(2);
    });
  });

  test("disconnecting stops every channel", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const connection = await insertConnection(tx, user.id, {
        domain: "calendar",
      });
      await tx.insert(calendarChannels).values({
        id: "c1",
        connectionId: connection.id,
        calendarId: "primary",
        resourceId: "r1",
        tokenHash: "x",
        expiresAt: new Date(Date.now() + day),
      });
      const api = calendarApi([]);
      await watchStopper(
        tx,
        { clientId: "id", clientSecret: "secret" },
        api.fetch,
      )(connection, "refresh");
      expect(api.calls).toEqual([
        {
          path: "/calendar/v3/channels/stop",
          body: { id: "c1", resourceId: "r1" },
        },
      ]);
      expect(await channelsOf(tx, connection.id)).toHaveLength(0);
    });
  });
});
