import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  outboundMessages,
  runMessages,
  runs,
  triggers,
} from "@winston/db/schema";
import { finishTask } from "@winston/db/tasks";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { asc, eq } from "drizzle-orm";
import { notesReminder, startTriggerRun } from "./trigger-run.ts";

const db = await testDb();

async function setup(
  tx: DbOrTx,
  trigger: Partial<typeof triggers.$inferInsert> = {},
) {
  const user = await insertUser(tx, { timezone: "America/New_York" });
  await tx.insert(inboundItems).values({
    userId: user.id,
    type: "user_message",
    payload: { text: "remind me about the lease <soon>", telegramMessageId: 1 },
    occurredAt: new Date("2026-10-01T13:00:00Z"),
  });
  const turn = await insertRun(tx, user.id, { status: "completed" });
  await tx.insert(outboundMessages).values({
    runId: turn.id,
    userId: user.id,
    text: "Will do.",
    telegramMessageIds: [2],
    sentAt: new Date("2026-10-01T13:00:05Z"),
  });
  const [row] = await tx
    .insert(triggers)
    .values({
      userId: user.id,
      kind: "schedule",
      cron: "0 8 * * 1-5",
      note: "Morning briefing: meetings and urgent mail.",
      nextFireAt: new Date("2026-10-02T12:00:00Z"),
      ...trigger,
    })
    .returning();
  if (!row) throw new Error("no trigger");
  return { userId: user.id, trigger: row };
}

const firstMessage = async (tx: DbOrTx, runId: string) => {
  const [row] = await tx
    .select({ content: runMessages.content })
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.seq));
  return String((row?.content as { content?: unknown } | undefined)?.content);
};

const triggerOf = async (tx: DbOrTx, id: string) =>
  (await tx.select().from(triggers).where(eq(triggers.id, id)))[0];

describe("trigger runs", () => {
  test("a schedule's run: low effort, its note, the read-only tail and the notes reminder; the fire is counted and the next time set", async () => {
    await inRollback(db, async (tx) => {
      const { trigger } = await setup(tx);
      const runId = await startTriggerRun(tx, {
        triggerId: trigger.id,
        reason: "schedule",
        now: new Date("2026-10-02T12:00:00Z"),
      });
      if (!runId) throw new Error("no run");
      const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
      expect(run).toMatchObject({
        kind: "background",
        status: "queued",
        effort: "low",
        triggerType: "schedule",
        triggerId: trigger.id,
        brief: "Morning briefing: meetings and urgent mail.",
      });
      const message = await firstMessage(tx, runId);
      expect(message).toMatch(
        new RegExp(
          `^<trigger id="${trigger.id}" kind="schedule" fired_at="[^"]+" reason="its scheduled time came">\\n<note>Morning briefing: meetings and urgent mail.</note>\\n</trigger>`,
        ),
      );
      expect(message).toContain("<conversation_tail>");
      expect(message).toContain("remind me about the lease &lt;soon&gt;");
      expect(message).toContain(
        '<winston_message sent_at="2026-10-01T09:00:05-04:00 (Thursday)">Will do.</winston_message>',
      );
      expect(message.endsWith(notesReminder)).toBe(true);
      expect(await triggerOf(tx, trigger.id)).toMatchObject({
        fireCount: 1,
        status: "active",
        nextFireAt: new Date("2026-10-05T12:00:00Z"),
      });
    });
  });

  test("an event run carries the events; a spent trigger never fires again", async () => {
    await inRollback(db, async (tx) => {
      const { trigger } = await setup(tx, {
        kind: "subscription",
        cron: null,
        nextFireAt: null,
        eventType: "mail.message.received",
        maxFires: 1,
        note: "Dana replied; summarize it.",
      });
      const event = {
        type: "mail.message.received",
        occurredAt: new Date("2026-10-02T15:00:00Z"),
        data: { messageId: "msg_01", subject: "Re: lease" },
      };
      const runId = await startTriggerRun(tx, {
        triggerId: trigger.id,
        reason: "event",
        events: [event],
      });
      expect(await firstMessage(tx, runId ?? "")).toContain(
        '<system_event type="mail.message.received">',
      );
      expect(await triggerOf(tx, trigger.id)).toMatchObject({
        fireCount: 1,
        status: "exhausted",
      });
      expect(
        await startTriggerRun(tx, {
          triggerId: trigger.id,
          reason: "event",
          events: [event],
        }),
      ).toBeUndefined();
      const all = await tx
        .select()
        .from(runs)
        .where(eq(runs.triggerId, trigger.id));
      expect(all).toHaveLength(1);
      expect((await triggerOf(tx, trigger.id))?.fireCount).toBe(1);
    });
  });

  test("expiry: an unfired trigger runs its on_expire note; a fired one just expires", async () => {
    await inRollback(db, async (tx) => {
      const expiring = {
        kind: "subscription" as const,
        cron: null,
        nextFireAt: null,
        eventType: "mail.message.received",
        maxFires: 1,
        expiresAt: new Date("2026-10-09T13:00:00Z"),
        onExpireNote: "Dana never replied; offer to draft a nudge.",
      };
      const now = new Date("2026-10-09T13:00:01Z");
      const { trigger } = await setup(tx, expiring);
      const runId = await startTriggerRun(tx, {
        triggerId: trigger.id,
        reason: "expire",
        now,
      });
      expect(await firstMessage(tx, runId ?? "")).toContain(
        "<note>Dana never replied; offer to draft a nudge.</note>",
      );
      expect((await triggerOf(tx, trigger.id))?.status).toBe("expired");

      const fired = await setup(tx, { ...expiring, fireCount: 1 });
      expect(
        await startTriggerRun(tx, {
          triggerId: fired.trigger.id,
          reason: "expire",
          now,
        }),
      ).toBeUndefined();
      expect((await triggerOf(tx, fired.trigger.id))?.status).toBe("expired");
    });
  });

  test("its report tells the front of house which kind of trigger started it", async () => {
    await inRollback(db, async (tx) => {
      const { userId, trigger } = await setup(tx);
      const runId = await startTriggerRun(tx, {
        triggerId: trigger.id,
        reason: "schedule",
      });
      await tx
        .update(runs)
        .set({ status: "running" })
        .where(eq(runs.id, runId ?? ""));
      await finishTask(
        tx,
        runId ?? "",
        "complete",
        "Nothing needs the user's attention.",
      );
      const [report] = await tx
        .select({ payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.type, "task.completed"));
      expect(report?.payload).toMatchObject({ trigger: "schedule" });
      expect(userId).toBeTruthy();
    });
  });
});
