import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  connectHandoff,
  createHandoff,
  handoffLink,
  reconnectHandoff,
  resolveFrontHandoffs,
} from "./handoffs.ts";
import { handoffs, inboundItems, runMessages } from "./schema/index.ts";
import { parkTask, resumeTask } from "./tasks.ts";
import { inRollback, insertRun, insertUser, testDb } from "./testing.ts";

const db = await testDb();

const window = { windowId: "win_1", targetId: "TARGET1", reason: "Sign in" };

describe("handoff links", () => {
  test("a link opens once; the page gets a secret to come back with, and nobody else does", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id, { kind: "background" });
      const { token } = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
      });
      expect(handoffLink("https://runwinston.com", token)).toBe(
        `https://runwinston.com/t/${token}`,
      );
      const first = await connectHandoff(tx, token);
      if (!first.ok) throw new Error("expected to connect");
      expect(first.handoff).toMatchObject({
        status: "connected",
        targetId: "TARGET1",
      });
      expect(await connectHandoff(tx, token)).toEqual({
        ok: false,
        reason: "used",
      });
      expect(await connectHandoff(tx, "made-up")).toEqual({
        ok: false,
        reason: "unknown",
      });
      expect(
        (await reconnectHandoff(tx, first.handoff.id, first.viewerSecret))?.id,
      ).toBe(first.handoff.id);
      expect(
        await reconnectHandoff(tx, first.handoff.id, "wrong"),
      ).toBeUndefined();
      // Only hashes are kept.
      const [row] = await tx.select().from(handoffs);
      expect(JSON.stringify(row)).not.toContain(token);
    });
  });

  test("an unopened link expires at its deadline, and a fresh one replaces it", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id, { kind: "background" });
      const stale = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
      });
      await tx
        .update(handoffs)
        .set({ connectDeadline: sql`now() - interval '1 second'` })
        .where(eq(handoffs.id, stale.id));
      expect(await connectHandoff(tx, stale.token)).toEqual({
        ok: false,
        reason: "expired",
      });
      const older = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
      });
      const fresh = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
      });
      expect(await connectHandoff(tx, older.token)).toEqual({
        ok: false,
        reason: "expired",
      });
      expect((await connectHandoff(tx, fresh.token)).ok).toBe(true);
    });
  });

  test("parking with a window puts the link in task.needs_user; resuming ends the handoff", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id, {
        kind: "background",
        brief: "Book a table",
      });
      await tx.insert(runMessages).values({
        runId: run.id,
        seq: 0,
        role: "assistant",
        content: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "browser_handoff",
              input: { reason: "Sign in to OpenTable" },
            },
          ],
        },
      });
      await parkTask(tx, run.id, "Sign in to OpenTable", 1, {
        windowId: "win_1",
        targetId: "TARGET1",
        webPublicUrl: "https://runwinston.com",
      });
      const [item] = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.type, "task.needs_user"));
      const link = (item?.payload as { link?: string }).link ?? "";
      expect(link).toStartWith("https://runwinston.com/t/");
      const token = link.split("/t/")[1] ?? "";
      expect((await connectHandoff(tx, token)).ok).toBe(true);
      await resumeTask(tx, run.id, "done");
      const [after] = await tx.select().from(handoffs);
      expect(after?.status).toBe("resolved");
    });
  });

  test("the user writing ends the front of house's handoffs only", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const front = await insertRun(tx, user.id, { kind: "front" });
      const task = await insertRun(tx, user.id, { kind: "background" });
      const mine = await createHandoff(tx, {
        runId: front.id,
        userId: user.id,
        ...window,
      });
      await createHandoff(tx, { runId: task.id, userId: user.id, ...window });
      expect(await resolveFrontHandoffs(tx, user.id)).toEqual([mine.id]);
      const statuses = (await tx.select().from(handoffs)).map((h) => [
        h.runId,
        h.status,
      ]);
      expect(statuses).toContainEqual([task.id, "open"]);
      expect(statuses).toContainEqual([front.id, "resolved"]);
    });
  });
});
