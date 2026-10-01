/**
 * Background runs ("tasks") as the rest of the system handles them
 * (docs/design.md §1, §11 `winston task`): ending one with its report,
 * queueing its next step, cancelling and resuming. The step engine lives in
 * `apps/agents`; these are shared with the VM-facing API.
 */
import { runStepJob } from "@winston/domain/jobs";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { enqueue } from "./queue.ts";
import { applyRunEvent } from "./run-state.ts";
import { runMessages, runs } from "./schema/index.ts";
import { recordSystemEvent } from "./system-events.ts";

/** How much of the brief a result repeats, so the front of house knows which task it was. */
export const briefPreviewChars = 200;

/** Queues a run's next step (at most one queued per run). */
export const queueTaskStep = (db: DbOrTx, userId: string, runId: string) =>
  enqueue(db, runStepJob.type, {
    userId,
    payload: { runId },
    dedupeKey: runStepJob.dedupeKey(runId),
    maxAttempts: runStepJob.maxAttempts,
  });

/**
 * Ends a run and reports the outcome to the front of house, together: only
 * the front of house messages the user (§4), so the result becomes a
 * `task.completed` or `task.failed` item, which queues a turn like any other
 * input. Returns the new status, or undefined if the run had already moved
 * on, in which case nothing is reported.
 */
export async function finishTask(
  db: DbOrTx,
  runId: string,
  event: "complete" | "cap" | "fail" | "cancel",
  report: string,
) {
  return db.transaction(async (tx) => {
    const result = report.trim() || "The task ended without a report.";
    const status = await applyRunEvent(tx, runId, event, { result });
    if (!status) return undefined;
    const [run] = await tx
      .select({
        userId: runs.userId,
        brief: runs.brief,
        triggerType: runs.triggerType,
      })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run) throw new Error(`No run ${runId}`);
    const trigger = run.triggerType === "delegate" ? null : run.triggerType;
    await recordSystemEvent(tx, {
      userId: run.userId,
      type: event === "fail" ? "task.failed" : "task.completed",
      payload: {
        taskId: runId,
        brief: briefPreview(run.brief),
        report: result,
        ...(event === "cap" ? { capped: true } : {}),
        ...(event === "cancel" ? { cancelled: true } : {}),
        ...(trigger ? { trigger } : {}),
      },
      sourceRef: `task:${runId}:finished`,
    });
    return status;
  });
}

/** The start of a brief, for a report's `<task>` line. */
function briefPreview(brief: string | null) {
  const chars = Array.from(brief ?? "");
  return chars.length > briefPreviewChars
    ? `${chars.slice(0, briefPreviewChars).join("")}…`
    : chars.join("");
}

/**
 * Parks a run that handed over to the user (§1, Browser handoff): no process
 * waits, it never times out, and the front of house hears what's needed as
 * a `task.needs_user` item. `task resume` picks it up again. Returns false if
 * the run had already moved on.
 */
export async function parkTask(
  db: DbOrTx,
  runId: string,
  reason: string,
  /** Distinguishes this handoff from the run's earlier ones. */
  step: number,
) {
  return db.transaction(async (tx) => {
    if (!(await applyRunEvent(tx, runId, "park"))) return false;
    const [run] = await tx
      .update(runs)
      .set({ waitingFor: reason })
      .where(eq(runs.id, runId))
      .returning({ userId: runs.userId, brief: runs.brief });
    if (!run) throw new Error(`No run ${runId}`);
    await recordSystemEvent(tx, {
      userId: run.userId,
      type: "task.needs_user",
      payload: { taskId: runId, brief: briefPreview(run.brief), reason },
      sourceRef: `task:${runId}:parked:${String(step)}`,
    });
    return true;
  });
}

export type CancelOutcome =
  "cancelled" | "cancelling" | "already_cancelling" | "finished";

/**
 * Cancels a background run. A queued or parked one ends now; a running one
 * is marked, and stops at its next step boundary (never mid-command) with a
 * short report of what it had done. Returns what happened.
 */
export async function cancelTask(
  db: DbOrTx,
  runId: string,
): Promise<CancelOutcome> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`No run ${runId}`);
  if (run.status === "queued" || run.status === "parked") {
    const report =
      run.status === "queued"
        ? "Cancelled before it started."
        : `Cancelled while parked, waiting on the user, after ${String(run.stepCount)} steps.`;
    return (await finishTask(db, runId, "cancel", report))
      ? "cancelled"
      : "finished";
  }
  if (run.status !== "running") return "finished";
  const [marked] = await db
    .update(runs)
    .set({ cancelRequestedAt: sql`now()` })
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.status, "running"),
        isNull(runs.cancelRequestedAt),
      ),
    )
    .returning({ id: runs.id });
  return marked ? "cancelling" : "already_cancelling";
}

/**
 * Resumes a parked run from its checkpoint: `note` (what the user said, like
 * "done") answers the tool call it parked on, or is added as the next input,
 * and its next step is queued. Returns false if the run isn't parked.
 */
export async function resumeTask(
  db: DbOrTx,
  runId: string,
  note: string | undefined,
) {
  return db.transaction(async (tx) => {
    const status = await applyRunEvent(tx, runId, "resume");
    if (!status) return false;
    const [run] = await tx
      .update(runs)
      .set({ waitingFor: null })
      .where(eq(runs.id, runId))
      .returning({ userId: runs.userId });
    const [last] = await tx
      .select({ seq: runMessages.seq, content: runMessages.content })
      .from(runMessages)
      .where(eq(runMessages.runId, runId))
      .orderBy(desc(runMessages.seq))
      .limit(1);
    if (!run || !last) throw new Error(`Run ${runId} has no messages.`);
    const text = `The user is done${note ? `. The front of house says: ${note}` : "."}`;
    // The handoff gets the note; anything asked for beside it never ran.
    const pending = pendingToolCalls(last.content as StoredMessage);
    const message: StoredMessage =
      pending.length > 0
        ? {
            role: "tool",
            content: pending.map((call) => ({
              type: "tool-result",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              output: {
                type: "text",
                value:
                  call.toolName === handoffTool ? text : notRunBesideHandoff,
              },
            })),
          }
        : { role: "user", content: text };
    await tx.insert(runMessages).values({
      runId,
      seq: last.seq + 1,
      role: message.role,
      content: message,
    });
    await queueTaskStep(tx, run.userId, runId);
    return true;
  });
}

/** The tool that parks a run; resuming answers it. */
export const handoffTool = "browser_handoff";

/** What a tool call made beside a handoff returns: it never ran. */
export const notRunBesideHandoff =
  "Not run: you handed over to the user first. Run it again if it's still needed.";

/** A stored AI SDK message, read through the little this module needs. */
interface StoredMessage {
  role: string;
  content: unknown;
}

/** The tool calls in an assistant message, which nothing has answered if it's the last one. */
function pendingToolCalls(message: StoredMessage) {
  if (message.role !== "assistant" || !Array.isArray(message.content))
    return [];
  return (
    message.content as { type: string; toolCallId: string; toolName: string }[]
  ).filter((part) => part.type === "tool-call");
}
