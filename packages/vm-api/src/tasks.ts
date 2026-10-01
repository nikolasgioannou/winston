/**
 * `winston task` (docs/design.md §11): the user's background runs. List and
 * get answer "what are you working on?"; cancel stops one at its next step
 * boundary; resume continues a parked one with a note.
 */
import type { DbOrTx } from "@winston/db/client";
import { runs, users } from "@winston/db/schema";
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
  brief: run.brief ?? "",
  result: run.result,
});

export function taskRoutes({ db }: { db: DbOrTx }) {
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

  return new Hono<VmApiEnv>()
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
      return c.json({ timeZone: await timeZoneOf(userId), task: taskDto(run) });
    })
    .post("/:id/cancel", async (c) => {
      const { userId } = c.get("run");
      const run = await taskFor(userId, c.req.param("id"));
      const outcome = await cancelTask(db, run.id);
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
        return c.json({ id: run.id, status: "running" as const });
      },
    );
}
