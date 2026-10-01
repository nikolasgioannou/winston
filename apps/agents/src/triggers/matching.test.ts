import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { refFor } from "@winston/db/external-refs";
import {
  events,
  jobs,
  runMessages,
  runs,
  triggerBatches,
  triggers,
} from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { asc, eq } from "drizzle-orm";
import { fireBatch, matchEvents, passesFilter } from "./matching.ts";

const db = await testDb();

const received = (overrides: Record<string, unknown> = {}) => ({
  messageId: "msg_x",
  threadId: "thr_x",
  account: "me@example.com",
  from: { name: "Dana Reyes", email: "dana@acme.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: "Re: Lease renewal",
  snippet: "Tuesday works",
  date: "2026-10-01T14:00:00.000Z",
  labels: ["Lease"],
  category: "primary",
  unread: true,
  hasAttachments: false,
  isReplyToUser: true,
  ...overrides,
});

let n = 0;
async function storeEvent(
  tx: DbOrTx,
  userId: string,
  connectionId: string,
  payload: Record<string, unknown>,
  options: { type?: string; selfCaused?: boolean } = {},
) {
  n += 1;
  const [row] = await tx
    .insert(events)
    .values({
      userId,
      connectionId,
      type: options.type ?? "mail.message.received",
      payload,
      occurredAt: new Date(Date.UTC(2026, 9, 1, 14, 0, n)),
      dedupeKey: `test:${String(n)}:${crypto.randomUUID()}`,
      selfCaused: options.selfCaused ?? false,
    })
    .returning();
  if (!row) throw new Error("no event");
  return row;
}

async function subscribe(
  tx: DbOrTx,
  userId: string,
  values: Partial<typeof triggers.$inferInsert> = {},
) {
  const [row] = await tx
    .insert(triggers)
    .values({
      userId,
      kind: "subscription",
      eventType: "mail.message.received",
      note: "Tell Nik if Dana wrote.",
      ...values,
    })
    .returning();
  if (!row) throw new Error("no trigger");
  return row;
}

const batchesOf = (tx: DbOrTx, triggerId: string) =>
  tx
    .select()
    .from(triggerBatches)
    .where(eq(triggerBatches.triggerId, triggerId));

describe("structured filters", () => {
  test("each field means what the search flag means", () => {
    const mail = received();
    expect(passesFilter(mail, { from: "dana" })).toBe(true);
    expect(
      passesFilter(mail, {
        from: "acme.com",
        unread: true,
        category: "primary",
      }),
    ).toBe(true);
    expect(passesFilter(mail, { from: "sam" })).toBe(false);
    expect(passesFilter(mail, { to: "me@" })).toBe(true);
    expect(passesFilter(mail, { subject: "lease" })).toBe(true);
    expect(passesFilter(mail, { label: "lease" })).toBe(true);
    expect(passesFilter(mail, { "has-attachment": true })).toBe(false);
    expect(passesFilter(mail, { "is-reply-to-user": true })).toBe(true);
    expect(passesFilter({ added: ["Lease"] }, { label: "Lease" })).toBe(true);
    const meeting = {
      event: {
        calendar: "me@example.com",
        title: "Board prep",
        organizer: { email: "pat@acme.com", name: "Pat" },
        attendees: [
          { email: "pat@acme.com", name: "Pat" },
          { email: "me@example.com", name: null },
          { email: "sam@other.com", name: "Sam" },
        ],
        external: true,
      },
    };
    expect(
      passesFilter(meeting, {
        attendee: "sam",
        organizer: "pat",
        external: true,
        title: "board",
      }),
    ).toBe(true);
    expect(passesFilter(meeting, { "min-attendees": 3 })).toBe(true);
    expect(passesFilter(meeting, { "min-attendees": 4 })).toBe(false);
    expect(passesFilter(meeting, { unknown: "x" })).toBe(false);
  });
});

describe("matching events to subscriptions", () => {
  test("type, account, scope, filter and native query must all agree; Winston's own changes fire nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const work = await insertConnection(tx, user.id, {
        externalEmail: "me@acme.com",
      });
      const home = await insertConnection(tx, user.id, {
        externalEmail: "me@home.com",
      });
      const thread = await refFor(tx, user.id, work.id, "thread", "t1");
      const message = await refFor(tx, user.id, work.id, "message", "gmail-1");
      const byType = await subscribe(tx, user.id);
      const homeOnly = await subscribe(tx, user.id, { connectionId: home.id });
      const scoped = await subscribe(tx, user.id, { scopeRef: thread });
      const otherThread = await subscribe(tx, user.id, {
        scopeRef: "thr_other",
      });
      const filtered = await subscribe(tx, user.id, {
        filter: { from: "dana", unread: true },
      });
      const sent = await subscribe(tx, user.id, {
        eventType: "mail.message.sent",
      });
      const nativeYes = await subscribe(tx, user.id, {
        nativeQuery: "has:attachment",
      });
      const nativeNo = await subscribe(tx, user.id, { nativeQuery: "label:x" });
      const asked: string[] = [];
      const event = await storeEvent(
        tx,
        user.id,
        work.id,
        received({ threadId: thread, messageId: message }),
      );
      await matchEvents(tx, [event], {
        native: (_connection, query, gmailId) => {
          asked.push(`${query} ${gmailId}`);
          return Promise.resolve(query === "has:attachment");
        },
      });
      const fired = async (id: string) => (await batchesOf(tx, id)).length;
      expect(await fired(byType.id)).toBe(1);
      expect(await fired(homeOnly.id)).toBe(0);
      expect(await fired(scoped.id)).toBe(1);
      expect(await fired(otherThread.id)).toBe(0);
      expect(await fired(filtered.id)).toBe(1);
      expect(await fired(sent.id)).toBe(0);
      expect(await fired(nativeYes.id)).toBe(1);
      expect(await fired(nativeNo.id)).toBe(0);
      expect(asked.sort()).toEqual([
        "has:attachment gmail-1",
        "label:x gmail-1",
      ]);

      const own = await storeEvent(tx, user.id, work.id, received(), {
        selfCaused: true,
      });
      await matchEvents(tx, [own]);
      expect((await batchesOf(tx, byType.id))[0]?.eventIds).toEqual([event.id]);
    });
  });

  test("five events close together are one batch, one job and one run with all five", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id);
      const trigger = await subscribe(tx, user.id);
      const burst = [];
      for (let i = 0; i < 5; i += 1)
        burst.push(
          await storeEvent(
            tx,
            user.id,
            mail.id,
            received({ subject: `Message ${String(i)}` }),
          ),
        );
      for (const event of burst) await matchEvents(tx, [event]);
      const [batch] = await batchesOf(tx, trigger.id);
      expect(batch?.eventIds).toEqual(burst.map((e) => e.id));
      const queued = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.type, "fire_trigger_batch"));
      expect(queued.map((j) => j.payload)).toEqual([{ batchId: batch?.id }]);
      const runId = await fireBatch(tx, batch?.id ?? 0);
      const [first] = await tx
        .select({ content: runMessages.content })
        .from(runMessages)
        .where(eq(runMessages.runId, runId ?? ""))
        .orderBy(asc(runMessages.seq));
      const text = (first?.content as { content: string }).content;
      expect(
        text.split('<system_event type="mail.message.received">').length - 1,
      ).toBe(5);
      expect((await batchesOf(tx, trigger.id))[0]).toMatchObject({
        status: "fired",
        runId,
      });
      // Firing again does nothing.
      expect(await fireBatch(tx, batch?.id ?? 0)).toBeUndefined();
    });
  });

  test("max_fires 1 fires once for a burst, and events after it match nothing", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mail = await insertConnection(tx, user.id);
      const trigger = await subscribe(tx, user.id, { maxFires: 1 });
      for (let i = 0; i < 3; i += 1)
        await matchEvents(tx, [
          await storeEvent(tx, user.id, mail.id, received()),
        ]);
      const [batch] = await batchesOf(tx, trigger.id);
      await fireBatch(tx, batch?.id ?? 0);
      await matchEvents(tx, [
        await storeEvent(tx, user.id, mail.id, received()),
      ]);
      expect(await batchesOf(tx, trigger.id)).toHaveLength(1);
      expect(
        await tx.select().from(runs).where(eq(runs.triggerId, trigger.id)),
      ).toHaveLength(1);
      const [after] = await tx
        .select()
        .from(triggers)
        .where(eq(triggers.id, trigger.id));
      expect(after).toMatchObject({ status: "exhausted", fireCount: 1 });
    });
  });
});
