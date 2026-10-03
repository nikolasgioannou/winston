import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  browserLink,
  createHandoff,
  openHandoffs,
  resolveFrontHandoffs,
} from "./handoffs.ts";
import { handoffs, inboundItems, runMessages } from "./schema/index.ts";
import { parkTask, resumeTask } from "./tasks.ts";
import { claimTelegramLogin } from "./telegram-logins.ts";
import { inRollback, insertRun, insertUser, testDb } from "./testing.ts";
import {
  issueViewerTicket,
  useViewerTicket,
  viewerTicketMs,
} from "./viewer-tickets.ts";

const db = await testDb();

const window = { windowId: "win_1", targetId: "TARGET1", reason: "Sign in" };

describe("handoffs", () => {
  test("a link names the window on the signed-in browser page; a new handoff of a run ends its last", async () => {
    await inRollback(db, async (tx) => {
      expect(browserLink("https://runwinston.com", "win_1")).toBe(
        "https://runwinston.com/browser?window=win_1",
      );
      expect(browserLink("https://runwinston.com")).toBe(
        "https://runwinston.com/browser",
      );
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id, { kind: "background" });
      const first = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
      });
      const second = await createHandoff(tx, {
        runId: run.id,
        userId: user.id,
        ...window,
        windowId: "win_2",
      });
      expect((await openHandoffs(tx, user.id)).map((h) => h.id)).toEqual([
        second.id,
      ]);
      const [old] = await tx
        .select()
        .from(handoffs)
        .where(eq(handoffs.id, first.id));
      expect(old?.status).toBe("resolved");
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
      expect((item?.payload as { link?: string }).link).toBe(
        "https://runwinston.com/browser?window=win_1",
      );
      expect((await openHandoffs(tx, user.id)).map((h) => h.windowId)).toEqual([
        "win_1",
      ]);
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
      expect(await resolveFrontHandoffs(tx, user.id)).toEqual([
        { id: mine.id, windowId: "win_1" },
      ]);
      const statuses = (await tx.select().from(handoffs)).map((h) => [
        h.runId,
        h.status,
      ]);
      expect(statuses).toContainEqual([task.id, "open"]);
      expect(statuses).toContainEqual([front.id, "resolved"]);
    });
  });
});

describe("viewer tickets", () => {
  test("a ticket signs one socket in, within a minute", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const now = new Date("2026-10-03T12:00:00Z");
      const ticket = await issueViewerTicket(tx, user.id, now);
      expect(await useViewerTicket(tx, "made-up", now)).toBeUndefined();
      expect(await useViewerTicket(tx, ticket, now)).toBe(user.id);
      expect(await useViewerTicket(tx, ticket, now)).toBeUndefined();
      const late = await issueViewerTicket(tx, user.id, now);
      expect(
        await useViewerTicket(
          tx,
          late,
          new Date(now.getTime() + viewerTicketMs + 1),
        ),
      ).toBeUndefined();
    });
  });
});

describe("Telegram logins", () => {
  test("each login's hash signs in once", async () => {
    await inRollback(db, async (tx) => {
      expect(await claimTelegramLogin(tx, "abc123")).toBe(true);
      expect(await claimTelegramLogin(tx, "abc123")).toBe(false);
      expect(await claimTelegramLogin(tx, "def456")).toBe(true);
    });
  });
});
