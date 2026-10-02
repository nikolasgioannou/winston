/**
 * `winston task` (docs/design.md §11): the user's background runs. List and
 * get answer "what are you working on?"; cancel stops one at its next step
 * boundary; resume continues a parked one with a note.
 */
import type { DbOrTx } from "@winston/db/client";
import { finalRunStatuses } from "@winston/db/run-state";
import { runs, users } from "@winston/db/schema";
import {
  createHandoff,
  handoffLink,
  latestHandoff,
} from "@winston/db/handoffs";
import { cancelTask, resumeTask } from "@winston/db/tasks";
import { parseHumanTime } from "@winston/shared/human-time";
import { and, desc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import { ApiFailure } from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

/** What `--status` means, in run statuses. */
const statusGroups = {
  running: ["queued", "running"],
  parked: ["parked"],
  done: ["completed", "capped", "cancelled"],
  failed: ["failed"],
} as const;

const listQuery = z.object({
  status: z.enum(["running", "parked", "done", "failed", "all"]).optional(),
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const resumeBody = z.object({ note: z.string().optional() });

const updateBody = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh"]),
});

type Run = typeof runs.$inferSelect;

/** A task as the CLI sees it. */
const taskDto = (run: Run) => ({
  id: run.id,
  status: run.status,
  trigger: run.triggerType ?? "manual",
  stepCount: run.stepCount,
  effort: run.effort ?? "high",
  createdAt: run.createdAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  cancelRequested: run.cancelRequestedAt !== null,
  /** While parked: what it's waiting for the user to do. */
  waitingFor: run.waitingFor,
  brief: run.brief ?? "",
  result: run.result,
});

/**
 * The browser a parked task handed over, on the user's VM (the gateway):
 * holding its window again for a fresh link, and letting it go when the
 * task carries on. Absent where there's no VM (some tests).
 */
export interface TaskBrowser {
  webPublicUrl: string;
  hold(
    userId: string,
    owner: string,
  ): Promise<{ windowId: string; targetId: string } | null>;
  release(userId: string, owner: string): void;
}

export function taskRoutes({
  db,
  browser,
}: {
  db: DbOrTx;
  browser?: TaskBrowser | undefined;
}) {
  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** The user's task with this id, or a not-found failure. */
  async function taskFor(userId: string, id: string) {
    const [run] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, id),
          eq(runs.userId, userId),
          eq(runs.kind, "background"),
        ),
      );
    if (!run)
      throw new ApiFailure(
        "not_found",
        `There's no task ${id}.`,
        "winston task list --status all shows them.",
      );
    return run;
  }

  return (
    new Hono<VmApiEnv>()
      .get("/", async (c) => {
        const parsed = listQuery.safeParse(c.req.query());
        if (!parsed.success)
          throw new ApiFailure(
            "invalid_request",
            z.prettifyError(parsed.error),
            "Run winston task list --help for the flags.",
          );
        const query = parsed.data;
        const { userId } = c.get("run");
        const timeZone = await timeZoneOf(userId);
        const conditions: (SQL | undefined)[] = [
          eq(runs.userId, userId),
          eq(runs.kind, "background"),
        ];
        const group = query.status ?? "active";
        if (group === "active")
          conditions.push(
            inArray(runs.status, [
              ...statusGroups.running,
              ...statusGroups.parked,
            ]),
          );
        else if (group !== "all")
          conditions.push(inArray(runs.status, [...statusGroups[group]]));
        if (query.since !== undefined)
          conditions.push(
            gte(
              runs.createdAt,
              parseHumanTime(query.since, { timeZone, direction: "past" }),
            ),
          );
        // Task ids are TypeIDs (UUIDv7), so they sort by creation time; the
        // cursor is the last id shown.
        if (query.cursor) conditions.push(lt(runs.id, query.cursor));
        const rows = await db
          .select()
          .from(runs)
          .where(and(...conditions))
          .orderBy(desc(runs.id))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const lastShown = page.at(-1);
        return c.json({
          timeZone,
          tasks: page.map(taskDto),
          cursor: rows.length > query.limit && lastShown ? lastShown.id : null,
        });
      })
      .get("/:id", async (c) => {
        const { userId } = c.get("run");
        const run = await taskFor(userId, c.req.param("id"));
        return c.json({
          timeZone: await timeZoneOf(userId),
          task: taskDto(run),
        });
      })
      .patch(
        "/:id",
        validator("json", (value) => {
          const parsed = updateBody.safeParse(value);
          if (!parsed.success)
            throw new ApiFailure(
              "invalid_request",
              z.prettifyError(parsed.error),
              "Pass --effort low, medium, high or xhigh.",
            );
          return parsed.data;
        }),
        async (c) => {
          const { userId, runId, runKind } = c.get("run");
          const asked = c.req.param("id");
          // `current` is the run making the call.
          if (asked === "current" && runKind !== "background")
            throw new ApiFailure(
              "not_supported",
              "Only background tasks have an effort to change; this is a conversation turn.",
              "Pass a task_ id to change a background task's effort.",
            );
          const run = await taskFor(
            userId,
            asked === "current" ? runId : asked,
          );
          if (finalRunStatuses.includes(run.status))
            throw new ApiFailure(
              "conflict",
              `${run.id} has already ended (${run.status}).`,
            );
          const { effort } = c.req.valid("json");
          const [updated] = await db
            .update(runs)
            .set({ effort })
            .where(eq(runs.id, run.id))
            .returning();
          return c.json({
            timeZone: await timeZoneOf(userId),
            task: taskDto(updated ?? run),
          });
        },
      )
      .post("/:id/cancel", async (c) => {
        const { userId } = c.get("run");
        const run = await taskFor(userId, c.req.param("id"));
        const outcome = await cancelTask(db, run.id);
        // A background run's windows are named by its id on the VM.
        if (outcome === "cancelled") browser?.release(userId, run.id);
        const [after] = await db
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, run.id));
        return c.json({
          id: run.id,
          outcome,
          status: after?.status ?? run.status,
        });
      })
      .post(
        "/:id/resume",
        validator("json", (value) => {
          const parsed = resumeBody.safeParse(value);
          if (!parsed.success)
            throw new ApiFailure(
              "invalid_request",
              z.prettifyError(parsed.error),
            );
          return parsed.data;
        }),
        async (c) => {
          const { userId } = c.get("run");
          const run = await taskFor(userId, c.req.param("id"));
          const { note } = c.req.valid("json");
          if (!(await resumeTask(db, run.id, note)))
            throw new ApiFailure(
              "conflict",
              `${run.id} isn't parked (it's ${run.status}), so there's nothing to resume.`,
              "Only a task waiting on the user can be resumed.",
            );
          browser?.release(userId, run.id);
          return c.json({ id: run.id, status: "running" as const });
        },
      )
      // A fresh live-view link for a parked task (the last one expired or was used).
      .post("/:id/link", async (c) => {
        const { userId } = c.get("run");
        const run = await taskFor(userId, c.req.param("id"));
        if (run.status !== "parked")
          throw new ApiFailure(
            "conflict",
            `${run.id} isn't waiting on the user (it's ${run.status}).`,
            "Only a parked task has a browser to hand over.",
          );
        if (!browser)
          throw new ApiFailure(
            "unavailable",
            "Live views aren't available here.",
            null,
          );
        const held = await browser.hold(userId, run.id).catch(() => null);
        const previous = await latestHandoff(db, run.id);
        const window = held ?? previous;
        if (!window)
          throw new ApiFailure(
            "not_found",
            `${run.id} has no browser window to show.`,
            "It handed over for something else; tell the user what it needs.",
          );
        const { token } = await createHandoff(db, {
          runId: run.id,
          userId,
          windowId: window.windowId,
          targetId: window.targetId,
          reason: run.waitingFor ?? previous?.reason ?? "",
        });
        return c.json({
          id: run.id,
          link: handoffLink(browser.webPublicUrl, token),
          expiresInMinutes: 15,
        });
      })
  );
}
