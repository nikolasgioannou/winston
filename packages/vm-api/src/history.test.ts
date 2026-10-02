import { describe, expect, test } from "bun:test";
import { toEnvelopeItems } from "@winston/db/envelopes";
import { auditLog, inboundItems, outboundMessages } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { renderBatch } from "@winston/domain/envelope";
import { sql } from "drizzle-orm";
import { setupApi } from "./testing.ts";

const db = await testDb();

interface Item {
  id: string;
  kind: string;
  at: string;
  envelope: string;
}

async function seed(tx: Parameters<typeof setupApi>[0]) {
  const user = await insertUser(tx, { timezone: "America/New_York" });
  const run = await insertRun(tx, user.id, { kind: "front" });
  const at = (iso: string) => new Date(iso);
  const [july, august] = await tx
    .insert(inboundItems)
    .values([
      {
        userId: user.id,
        type: "user_message",
        payload: {
          text: "Book us a table at Zuni Café for Friday",
          telegramMessageId: 1,
        },
        occurredAt: at("2026-07-14T23:00:00Z"),
      },
      {
        userId: user.id,
        type: "user_message",
        payload: {
          text: "What's on my calendar tomorrow?",
          telegramMessageId: 2,
        },
        occurredAt: at("2026-08-02T13:00:00Z"),
      },
    ])
    .returning();
  const [reply] = await tx
    .insert(outboundMessages)
    .values({
      userId: user.id,
      runId: run.id,
      text: "Booked Zuni for 7:30 on Friday, confirmation ZX-4471.",
      sentAt: at("2026-07-14T23:05:00Z"),
    })
    .returning();
  if (!reply) throw new Error("Seeding failed.");
  // Microseconds, as now() stores them: context ordering must keep them.
  await tx.execute(
    sql`update outbound_messages set sent_at = sent_at + interval '123 microseconds' where id = ${reply.id}`,
  );
  await tx.insert(inboundItems).values({
    userId: user.id,
    type: "task.completed",
    payload: {
      taskId: "task_1",
      brief: "Compare keyboard prices",
      report: "The Keychron K2 is cheapest at $59.99.",
    },
    occurredAt: at("2026-08-10T15:00:00Z"),
  });
  const [action] = await tx
    .insert(auditLog)
    .values({
      userId: user.id,
      action: "mail.send",
      summary: "Replied to Dana Reyes: Re: Lease renewal",
      request: {},
      outcome: "ok",
      createdAt: at("2026-08-05T16:00:00Z"),
    })
    .returning();
  // Someone else's history never shows.
  const other = await insertUser(tx);
  await tx.insert(inboundItems).values({
    userId: other.id,
    type: "user_message",
    payload: { text: "Zuni Café for my birthday", telegramMessageId: 9 },
    occurredAt: at("2026-07-20T12:00:00Z"),
  });
  if (!july || !august || !action) throw new Error("Seeding failed.");
  return { user, run, july, august, reply, action };
}

const search = async (
  call: ReturnType<ReturnType<typeof setupApi>["as"]>,
  query: string,
) => {
  const response = await call(`/v1/history/search?${query}`);
  return (await response.json()) as {
    items: Item[];
    nextCursor: string | null;
  };
};

describe("history", () => {
  test("search finds messages, replies, task reports and actions, ranked, as their envelopes", async () => {
    await inRollback(db, async (tx) => {
      const { user, july, reply, action } = await seed(tx);
      const call = setupApi(tx).as(user.id);

      const zuni = await search(call, "text=zuni");
      expect(zuni.items.map((i) => i.id).sort()).toEqual(
        [july.id, reply.id].sort(),
      );
      // Exact on ids and names; stemmed on words ("booking" finds "Booked").
      expect(
        (await search(call, "text=ZX-4471")).items.map((i) => i.id),
      ).toEqual([reply.id]);
      expect(
        (await search(call, "text=booking")).items.map((i) => i.id).sort(),
      ).toEqual([july.id, reply.id].sort());
      expect((await search(call, "text=dana lease")).items).toMatchObject([
        { id: action.historyId, kind: "action" },
      ]);
      expect((await search(call, "text=keychron")).items).toMatchObject([
        { kind: "task" },
      ]);

      // The user's message reads exactly as in the context window.
      const [item] = await toEnvelopeItems(tx, user.id, [july]);
      const fromSearch = zuni.items.find((i) => i.id === july.id);
      expect(fromSearch?.envelope).toBe(
        renderBatch(item ? [item] : [], "America/New_York"),
      );
      expect(fromSearch?.envelope).toContain(
        '<system_event type="user_message">',
      );
      expect(zuni.items.find((i) => i.id === reply.id)?.envelope).toContain(
        '<system_event type="winston.message">',
      );
      expect((await search(call, "text=dana")).items[0]?.envelope).toContain(
        "<action>mail.send</action>",
      );
    });
  });

  test("filters by type and date, newest first without text, and pages with a cursor", async () => {
    await inRollback(db, async (tx) => {
      const { user, august, july } = await seed(tx);
      const call = setupApi(tx).as(user.id);
      const messages = await search(call, "type=message&limit=2");
      expect(messages.items.every((i) => i.kind === "message")).toBe(true);
      expect(messages.items[0]?.id).toBe(august.id);
      expect(messages.nextCursor).not.toBeNull();
      const next = await search(
        call,
        `type=message&limit=2&cursor=${messages.nextCursor ?? ""}`,
      );
      expect(next.items.map((i) => i.id)).toEqual([july.id]);
      expect(next.nextCursor).toBeNull();

      const inAugust = await search(call, "since=2026-08-01&until=2026-08-06");
      expect(inAugust.items.map((i) => i.kind).sort()).toEqual([
        "action",
        "message",
      ]);
    });
  });

  test("get shows an item with what came before and after; another user's item isn't found", async () => {
    await inRollback(db, async (tx) => {
      const { user, july, reply, august } = await seed(tx);
      const call = setupApi(tx).as(user.id);
      const response = await call(`/v1/history/${reply.id}?context=1`);
      const body = (await response.json()) as { items: Item[] };
      expect(body.items.map((i) => i.id)).toEqual([
        july.id,
        reply.id,
        august.id,
      ]);

      const other = await insertUser(tx);
      const theirs = setupApi(tx).as(other.id);
      expect((await theirs(`/v1/history/${reply.id}`)).status).toBe(404);
      expect((await search(theirs, "text=booked")).items).toEqual([]);
    });
  });
});
