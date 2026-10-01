/**
 * Background runs (docs/design.md §1, §9): a task started with a brief, worked
 * one step at a time. Each step is its own `run_step` job: load the run's
 * messages, call the model once, store its message, run its tools, store
 * their results, queue the next step. Everything a step needs is in
 * `run_messages`, so any worker can take any step, and a crash or deploy
 * costs at most the step in flight.
 *
 * The model's message is stored before its tools run. If a worker dies in
 * between, the next attempt can't know whether the tools ran, so each call
 * gets a result saying so instead of being run again blindly (a second
 * `winston mail send` would send twice).
 */
import type { DbOrTx } from "@winston/db/client";
import { newId } from "@winston/db/ids";
import { applyRunEvent } from "@winston/db/run-state";
import { runMessages, runs, users } from "@winston/db/schema";
import {
  finishTask,
  handoffTool,
  parkTask,
  queueTaskStep,
} from "@winston/db/tasks";
import { promptVersion, systemPrompts } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { formatInTimeZone } from "@winston/shared/time";
import {
  APICallError,
  isStepCount,
  type ModelMessage,
  type Tool,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import { asc, eq, sql } from "drizzle-orm";
import { storableMessage, type BlobStore } from "../blobs.ts";
import { cacheBreakpoint, withRollingBreakpoint } from "../model/cache.ts";
import type { Effort, ModelGateway } from "../model/gateway.ts";
import { bashDefinition, bashTool } from "../tools/bash.ts";
import {
  backgroundHandoffTool,
  browserHandoffDefinition,
} from "../tools/handoff.ts";
import { viewImageDefinition, viewImageTool } from "../tools/view-image.ts";
import type { VmClient } from "../vm/gateway-client.ts";
import { rehydrateImages } from "./images.ts";

/** Most model calls in one run, the last of them the summary (§1, "Only limit"). */
export const maxStepsPerRun = 100;

/** Quick retries after a transient model error, before the job's own backoff takes over (§6). */
export const backgroundRetries = 2;

/** Each model call's time limit; Opus at high effort can think for a while. */
export const backgroundCallTimeoutMs = 5 * 60_000;

/** Added as the last step when the run reaches the step cap. */
export const capNote =
  "You've reached the step limit for this task, so stop here. Don't call any tools. Write your report now: what you did, where you got to, what's left and anything waiting on the user.";

/** Added as the last step when the task was cancelled. */
export const cancelNote =
  "This task has been cancelled, so stop here. Don't call any tools. Write a short report of what you did and anything left half-done.";

/** What a tool call returns when the task was cancelled before it ran. */
export const cancelledToolNote = "Not run: the task was cancelled.";

/** Added once when the model ends without a report. */
export const emptyReportNudge =
  "You stopped without writing a report. Write it now, with no tool calls.";

/** The result for a tool call whose step was interrupted after the model asked for it. */
export const interruptedNote =
  "Unknown: the worker restarted while this was running, so it may or may not have happened. Check before doing it again.";

// Tools in the order the model sees them; the prompt version hashes them in that order.
const prompt = promptVersion("background", [
  bashDefinition("background"),
  viewImageDefinition,
  browserHandoffDefinition,
]);
const instructions = cacheBreakpoint({
  role: "system" as const,
  content: systemPrompts.background,
});

export interface BackgroundDeps {
  db: DbOrTx;
  logger: Logger;
  gateway: ModelGateway;
  vm: VmClient;
  runTokenSecret: string;
  blobs: BlobStore;
  /** For tests: the pause before a quick retry. */
  retryDelayMs?: number;
}

/**
 * Starts a background run: the run (`task_…`, queued), its brief as the first
 * message, and its first step, together. Returns the run's id.
 */
export async function startBackgroundRun(
  db: DbOrTx,
  options: {
    userId: string;
    brief: string;
    effort?: Effort;
    /** What started it, and the front-of-house turn that did. */
    triggerType?: "delegate";
    parentRunId?: string;
  },
) {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ timeZone: users.timezone })
      .from(users)
      .where(eq(users.id, options.userId));
    if (!user) throw new Error(`No user ${options.userId}`);
    const runId = newId("task");
    await tx.insert(runs).values({
      id: runId,
      userId: options.userId,
      kind: "background",
      status: "queued",
      brief: options.brief,
      effort: options.effort,
      triggerType: options.triggerType,
      parentRunId: options.parentRunId,
    });
    const message: ModelMessage = {
      role: "user",
      content: `<task started_at="${formatInTimeZone(new Date(), user.timeZone)}">\n${options.brief}\n</task>`,
    };
    await tx
      .insert(runMessages)
      .values({ runId, seq: 0, role: "user", content: message });
    await queueTaskStep(tx, options.userId, runId);
    return runId;
  });
}

/**
 * Runs one step of a background run. Returns what happened: the step ran and
 * queued the next, the run finished, or there was nothing to do (the run was
 * cancelled, parked or already over). Throws when the model keeps failing,
 * so the job retries from the same checkpoint.
 */
export async function runBackgroundStep(
  deps: BackgroundDeps,
  runId: string,
  signal?: AbortSignal,
): Promise<"continued" | "finished" | "parked" | "skipped"> {
  const { db, gateway } = deps;
  const logger = deps.logger.child({ runId });
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (run?.kind !== "background") throw new Error(`No background run ${runId}`);
  if (run.status === "queued") await applyRunEvent(db, runId, "start");
  else if (run.status !== "running") {
    logger.info({ status: run.status }, "run isn't running; no step to take");
    return "skipped";
  }

  const stored = await db
    .select({ id: runMessages.id, content: runMessages.content })
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.seq));
  const messages = stored.map((row) => row.content as ModelMessage);
  let lastStoredId = stored.at(-1)?.id ?? 0;
  const firstId = stored[0]?.id ?? 0;
  const store = async (message: ModelMessage) => {
    signal?.throwIfAborted();
    const [row] = await db
      .insert(runMessages)
      .values({
        runId,
        seq: messages.length,
        role: message.role,
        content: message,
      })
      .returning({ id: runMessages.id });
    if (!row) throw new Error("Storing a run message returned no row.");
    messages.push(message);
    lastStoredId = row.id;
  };

  // A step that died after the model asked for tools: their fate is unknown.
  const unanswered = unansweredToolCalls(messages);
  if (unanswered.length > 0) {
    logger.warn(
      { calls: unanswered.length },
      "resuming after an interrupted step; its tool calls get an unknown result",
    );
    await store(
      toolMessage(
        unanswered.map((call) => ({
          call,
          output: { type: "text", value: interruptedNote },
        })),
      ),
    );
  }

  // The last call: cancelled, or at the step cap. No tools, just the report.
  const cancelling = run.cancelRequestedAt !== null;
  const capped = !cancelling && run.stepCount >= maxStepsPerRun - 1;
  const last = cancelling || capped;
  if (cancelling) await store({ role: "user", content: cancelNote });
  else if (capped) await store({ role: "user", content: capNote });

  const tools = {
    bash: bashTool({
      vm: deps.vm,
      logger,
      runTokenSecret: deps.runTokenSecret,
      run: { runId, userId: run.userId, kind: "background" },
    }),
    view_image: viewImageTool({ vm: deps.vm, logger, userId: run.userId }),
  };
  // The model only asks for tools; this step runs them after storing the request.
  const requests = {
    bash: withoutExecute(tools.bash),
    view_image: withoutExecute(tools.view_image),
    [handoffTool]: backgroundHandoffTool,
  };

  const call = async () => {
    for (let retry = 0; ; retry += 1) {
      try {
        return await gateway.generate({
          profile: "background",
          ...(run.effort ? { effort: run.effort } : {}),
          run: {
            runId,
            userId: run.userId,
            prompt,
            contextRange: () => ({
              fromMessageId: firstId,
              toMessageId: lastStoredId,
            }),
          },
          stepOffset: run.stepCount,
          instructions,
          messages: withRollingBreakpoint(
            await rehydrateImages(messages, deps.blobs),
          ),
          tools: requests,
          ...(last ? { toolChoice: "none" as const } : {}),
          stopWhen: isStepCount(1),
          timeout: backgroundCallTimeoutMs,
          ...(signal ? { abortSignal: signal } : {}),
        });
      } catch (error) {
        if (
          !isTransient(error) ||
          retry >= backgroundRetries ||
          signal?.aborted
        )
          throw error;
        logger.warn(
          { err: error, retry: retry + 1 },
          "transient model error; retrying",
        );
        await sleep(deps.retryDelayMs ?? 1000);
      }
    }
  };

  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call();
  } catch (error) {
    // A cancelled task ends even if its report can't be written.
    if (!cancelling || signal?.aborted) throw error;
    logger.warn({ err: error }, "the cancelled task's report failed");
    await finishTask(
      db,
      runId,
      "cancel",
      `Cancelled after ${String(run.stepCount)} steps, before it could write a report.`,
    );
    return "finished";
  }
  for (const message of result.responseMessages) await store(message);
  await db
    .update(runs)
    .set({ stepCount: sql`${runs.stepCount} + 1` })
    .where(eq(runs.id, runId));
  const step = result.finalStep;

  if (step.rawFinishReason === "refusal") {
    await finishTask(db, runId, "fail", "The model refused this task.");
    logger.warn("the model refused the task");
    return "finished";
  }

  if (last || step.toolCalls.length === 0) {
    const report = step.text.trim();
    if (!report && !last && !messages.some(isNudge)) {
      logger.warn("the run ended without a report; nudging once");
      await store({ role: "user", content: emptyReportNudge });
      await queueTaskStep(db, run.userId, runId);
      return "continued";
    }
    const event = cancelling ? "cancel" : capped ? "cap" : "complete";
    await finishTask(db, runId, event, report);
    logger.info({ event }, "run finished");
    return "finished";
  }

  const calls = step.toolCalls.map((requested): ToolCallPart => ({
    type: "tool-call",
    toolCallId: requested.toolCallId,
    toolName: requested.toolName,
    input: requested.input,
  }));
  // Cancelled while the model was thinking: its tools don't start.
  const [latest] = await db
    .select({ cancelRequestedAt: runs.cancelRequestedAt })
    .from(runs)
    .where(eq(runs.id, runId));
  if (latest?.cancelRequestedAt) {
    await store(
      toolMessage(
        calls.map((call) => ({
          call,
          output: { type: "text", value: cancelledToolNote },
        })),
      ),
    );
    await queueTaskStep(db, run.userId, runId);
    return "continued";
  }

  // Handed over to the user: park, with the call unanswered until resumed.
  const handoff = calls.find((call) => call.toolName === handoffTool);
  if (handoff) {
    const { reason } = handoff.input as { reason?: unknown };
    await parkTask(
      db,
      runId,
      typeof reason === "string" && reason.trim()
        ? reason.trim()
        : "The task needs the user to take over.",
      run.stepCount + 1,
    );
    logger.info("handed over to the user; parked");
    return "parked";
  }

  const outputs: { call: ToolCallPart; output: ToolResultPart["output"] }[] =
    [];
  for (const [i, call] of calls.entries()) {
    const requested = step.toolCalls[i];
    outputs.push({
      call,
      output: await runTool(
        tools,
        call,
        messages,
        requested !== undefined &&
          "invalid" in requested &&
          requested.invalid === true,
        signal,
      ),
    });
  }
  await store(await storableMessage(toolMessage(outputs), deps.blobs));
  signal?.throwIfAborted();
  await queueTaskStep(db, run.userId, runId);
  return "continued";
}

/** A tool with its `execute` removed, so the model's call comes back unrun. */
function withoutExecute(tool: Tool): Tool {
  return { ...tool, execute: undefined } as unknown as Tool;
}

/** Runs one requested tool and returns its output as the model reads it. */
async function runTool(
  tools: Record<string, Tool>,
  call: ToolCallPart,
  messages: ModelMessage[],
  invalid: boolean,
  signal: AbortSignal | undefined,
): Promise<ToolResultPart["output"]> {
  const tool = tools[call.toolName];
  if (!tool?.execute)
    return { type: "error-text", value: `There's no tool ${call.toolName}.` };
  if (invalid)
    return {
      type: "error-text",
      value: `The input doesn't match ${call.toolName}'s schema.`,
    };
  try {
    const output: unknown = await tool.execute(call.input, {
      toolCallId: call.toolCallId,
      messages,
      context: undefined,
      ...(signal ? { abortSignal: signal } : {}),
    });
    if (tool.toModelOutput)
      return await tool.toModelOutput({
        toolCallId: call.toolCallId,
        input: call.input,
        output,
      });
    return typeof output === "string"
      ? { type: "text", value: output }
      : { type: "json", value: output as never };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      type: "error-text",
      value: error instanceof Error ? error.message : String(error),
    };
  }
}

function toolMessage(
  results: { call: ToolCallPart; output: ToolResultPart["output"] }[],
): ModelMessage {
  return {
    role: "tool",
    content: results.map(({ call, output }) => ({
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    })),
  };
}

/** The tool calls in the last assistant message that no tool message answers. */
export function unansweredToolCalls(messages: readonly ModelMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return [];
  return last.content.filter(
    (part): part is ToolCallPart => part.type === "tool-call",
  );
}

const isNudge = (message: ModelMessage) =>
  message.role === "user" && message.content === emptyReportNudge;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worth a quick retry: rate limits, server errors, timeouts, dropped connections. */
function isTransient(error: unknown) {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
