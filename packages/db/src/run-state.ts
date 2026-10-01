/**
 * The run state machine (docs/design.md §17), for background runs: one place
 * that decides which moves are legal, applied with the row locked.
 * Front-of-house turns only ever go running → completed | failed.
 */
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { runs, type runStatus } from "./schema/index.ts";

export type RunStatus = (typeof runStatus.enumValues)[number];

export type RunEvent =
  "start" | "complete" | "fail" | "cancel" | "cap" | "park" | "resume";

/** From each status, the events it accepts and where they lead. */
const transitions: Record<RunStatus, Partial<Record<RunEvent, RunStatus>>> = {
  queued: { start: "running", fail: "failed", cancel: "cancelled" },
  running: {
    complete: "completed",
    fail: "failed",
    cancel: "cancelled",
    cap: "capped",
    park: "parked",
  },
  parked: { resume: "running", fail: "failed", cancel: "cancelled" },
  completed: {},
  failed: {},
  cancelled: {},
  capped: {},
};

/** Statuses a run never leaves. */
export const finalRunStatuses: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "capped",
];

/** The status `event` leads to from `status`. Throws on an illegal move. */
export function transitionRun(status: RunStatus, event: RunEvent): RunStatus {
  const next = transitions[status][event];
  if (!next) throw new Error(`Illegal run transition: ${event} from ${status}`);
  return next;
}

/**
 * Applies `event` to a run with its row locked, setting `result` if given and
 * `finished_at` when the run ends. Returns the new status, or undefined if
 * the move isn't legal from where the run is now (it was cancelled
 * meanwhile, say), so callers decide whether that's an error.
 */
export async function applyRunEvent(
  db: DbOrTx,
  runId: string,
  event: RunEvent,
  changes: { result?: string } = {},
): Promise<RunStatus | undefined> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (!run) throw new Error(`No run ${runId}`);
    const next = transitions[run.status][event];
    if (!next) return undefined;
    await tx
      .update(runs)
      .set({
        status: next,
        ...(changes.result === undefined ? {} : { result: changes.result }),
        ...(finalRunStatuses.includes(next) ? { finishedAt: sql`now()` } : {}),
      })
      .where(eq(runs.id, runId));
    return next;
  });
}
