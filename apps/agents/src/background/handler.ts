import { lockSpaces, withAdvisoryLock } from "../lock.ts";
import type { JobHandler } from "../worker.ts";
import { finishTask } from "@winston/db/tasks";
import { runBackgroundStep, type BackgroundDeps } from "./run.ts";

/** How long each lease extension lasts; it's renewed at a third of that. */
export const stepLeaseMs = 60_000;

/**
 * The `run_step` job: one step of a background run (docs/design.md §9).
 *
 * - One step at a time per run: a step holds the run's advisory lock, and a
 *   job that finds it taken ends without work (the running step queues the
 *   next).
 * - A step can run for minutes (a long command), so the lease is renewed
 *   while it works. If it's lost anyway, the step stops before storing
 *   anything more, and whoever leased the job takes over from the checkpoint.
 * - A failure is retried with backoff from the same checkpoint. When the last
 *   attempt fails, the run fails with the reason, for the front of house.
 */
export function runStepHandler(
  deps: Omit<BackgroundDeps, "db" | "logger">,
): JobHandler {
  return async ({ job, db, logger, extendLease }) => {
    const { runId } = job.payload as { runId?: string };
    if (!runId) throw new Error("run_step job has no run");
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void extendLease(stepLeaseMs).then((held) => {
        if (!held) controller.abort(new Error("The step's lease was lost."));
      });
    }, stepLeaseMs / 3);
    try {
      const outcome = await withAdvisoryLock(
        db,
        lockSpaces.runStep,
        runId,
        () =>
          runBackgroundStep({ ...deps, db, logger }, runId, controller.signal),
      );
      if (outcome === "busy")
        logger.info("another step of this run is running; leaving it to that");
    } catch (error) {
      if (job.attempts >= job.maxAttempts && !controller.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error);
        await finishTask(db, runId, "fail", `The task failed: ${reason}`);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  };
}
