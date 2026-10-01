import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { newId } from "@winston/db/ids";
import { inboundItems, jobs, runMessages, runs } from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { and, asc, eq } from "drizzle-orm";
import { setupApi } from "./testing.ts";

const db = await testDb();

type Json = Record<string, unknown>;
interface Listed {
  tasks: { id: string; status: string; brief: string }[];
  cursor: string | null;
}

/** A background run in `status`, with its brief as the first message. */
async function task(
  tx: DbOrTx,
  userId: string,
  status: (typeof runs.$inferInsert)["status"],
  brief = `task in ${String(status)}`,
  last?: unknown,
) {
  const [run] = await tx
    .insert(runs)
    .values({
      id: newId("task"),
      userId,
      kind: "background",
      status,
      brief,
      triggerType: "delegate",
    })
    .returning();
  if (!run) throw new Error("no run");
  await tx.insert(runMessages).values({
    runId: run.id,
    seq: 0,
    role: "user",
    content: { role: "user", content: brief },
  });
  if (last)
    await tx.insert(runMessages).values({
      runId: run.id,
      seq: 1,
      role: "assistant",
      content: last,
    });
  return run.id;
}

describe("task routes", () => {
  test("list shows running and parked by default, others by --status, newest first, and pages", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const running = await task(tx, user.id, "running");
      const parked = await task(tx, user.id, "parked");
      await task(tx, user.id, "completed");
      await task(tx, user.id, "failed");
      const other = await insertUser(tx);
      await task(tx, other.id, "running");
      const call = setupApi(tx).as(user.id);
      const list = async (query = "") =>
        (await (await call(`/v1/tasks${query}`)).json()) as Listed;
      expect((await list()).tasks.map((t) => t.id).sort()).toEqual(
        [running, parked].sort(),
      );
      expect((await list("?status=done")).tasks.map((t) => t.status)).toEqual([
        "completed",
      ]);
      expect((await list("?status=all")).tasks).toHaveLength(4);
      const first = await list("?status=all&limit=3");
      expect(first.tasks).toHaveLength(3);
      const rest = await list(
        `?status=all&limit=3&cursor=${first.cursor ?? ""}`,
      );
      expect(rest.tasks).toHaveLength(1);
      expect(rest.cursor).toBeNull();
    });
  });

  test("get shows a task; another user's isn't found", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const id = await task(tx, user.id, "running", "Compare lease offers");
      const other = await insertUser(tx);
      const call = setupApi(tx).as(user.id);
      expect(await (await call(`/v1/tasks/${id}`)).json()).toMatchObject({
        task: {
          id,
          status: "running",
          trigger: "delegate",
          brief: "Compare lease offers",
          cancelRequested: false,
        },
      });
      const theirs = await setupApi(tx).as(other.id)(`/v1/tasks/${id}`);
      expect(theirs.status).toBe(404);
    });
  });

  test("cancel ends a queued or parked task now, with a report, and marks a running one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const queued = await task(tx, user.id, "queued");
      const parked = await task(tx, user.id, "parked");
      const running = await task(tx, user.id, "running");
      const done = await task(tx, user.id, "completed");
      const call = setupApi(tx).as(user.id);
      const cancel = async (id: string) =>
        (await (
          await call(`/v1/tasks/${id}/cancel`, { method: "POST" })
        ).json()) as Json;
      expect(await cancel(queued)).toMatchObject({
        outcome: "cancelled",
        status: "cancelled",
      });
      expect(await cancel(parked)).toMatchObject({ outcome: "cancelled" });
      expect(await cancel(running)).toMatchObject({
        outcome: "cancelling",
        status: "running",
      });
      expect(await cancel(running)).toMatchObject({
        outcome: "already_cancelling",
      });
      expect(await cancel(done)).toMatchObject({ outcome: "finished" });
      const reports = await tx
        .select({ payload: inboundItems.payload })
        .from(inboundItems)
        .where(eq(inboundItems.userId, user.id));
      expect(reports.map((r) => r.payload)).toEqual([
        expect.objectContaining({
          taskId: queued,
          report: "Cancelled before it started.",
          cancelled: true,
        }),
        expect.objectContaining({ taskId: parked, cancelled: true }),
      ]);
    });
  });

  test("resume continues a parked task with the note, answering the call it parked on; anything else is a conflict", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const parked = await task(tx, user.id, "parked", "Book the table", {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_9",
            toolName: "browser_handoff",
            input: { reason: "captcha" },
          },
        ],
      });
      const running = await task(tx, user.id, "running");
      const call = setupApi(tx).as(user.id);
      const resumed = await call(`/v1/tasks/${parked}/resume`, {
        method: "POST",
        body: { note: "user says done" },
      });
      expect(await resumed.json()).toEqual({ id: parked, status: "running" });
      const messages = await tx
        .select({ content: runMessages.content })
        .from(runMessages)
        .where(eq(runMessages.runId, parked))
        .orderBy(asc(runMessages.seq));
      expect(messages.at(-1)?.content).toEqual({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_9",
            toolName: "browser_handoff",
            output: {
              type: "text",
              value:
                "The user is done. The front of house says: user says done",
            },
          },
        ],
      });
      const steps = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, "run_step"), eq(jobs.userId, user.id)));
      expect(steps.map((j) => j.payload)).toEqual([{ runId: parked }]);

      const conflict = await call(`/v1/tasks/${running}/resume`, {
        method: "POST",
        body: {},
      });
      expect(conflict.status).toBe(409);
      expect(
        ((await conflict.json()) as { error: { message: string } }).error
          .message,
      ).toContain("isn't parked (it's running)");
    });
  });

  test("update changes a task's effort; with no id, the background task calling", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const mine = await task(tx, user.id, "running");
      const other = await task(tx, user.id, "parked");
      const done = await task(tx, user.id, "completed");
      const api = setupApi(tx);
      const patch = (
        caller: ReturnType<typeof api.as>,
        id: string,
        body: unknown,
      ) => caller(`/v1/tasks/${id}`, { method: "PATCH", body });
      const fromTask = api.as(user.id, mine, "background");
      const updated = await patch(fromTask, "current", { effort: "xhigh" });
      expect(await updated.json()).toMatchObject({
        task: { id: mine, effort: "xhigh" },
      });
      expect(
        (await patch(api.as(user.id), other, { effort: "low" })).status,
      ).toBe(200);
      const [row] = await tx.select().from(runs).where(eq(runs.id, other));
      expect(row?.effort).toBe("low");
      expect(
        (await patch(api.as(user.id), "current", { effort: "high" })).status,
      ).toBe(422);
      expect((await patch(fromTask, mine, { effort: "max" })).status).toBe(400);
      expect((await patch(fromTask, done, { effort: "high" })).status).toBe(
        409,
      );
    });
  });
});
