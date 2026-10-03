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
import { modelCalls, runMessages, runs, users } from "@winston/db/schema";
import {
  finishTask,
  handoffTool,
  parkTask,
  queueTaskStep,
} from "@winston/db/tasks";
import { promptVersion, systemPrompts } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { formatEnvelopeTime } from "@winston/shared/time";
import {
  APICallError,
  isStepCount,
  type ModelMessage,
  type Tool,
  type ToolCallPart,
  type ToolResultPart,
} from "ai";
import { asc, desc, eq, sql } from "drizzle-orm";
import { storableMessage, type BlobStore } from "../blobs.ts";
import { cacheBreakpoint, withRollingBreakpoint } from "../model/cache.ts";
import type { Effort, ModelGateway } from "../model/gateway.ts";
import {
  bashDefinition,
  bashOutput,
  bashTool,
  execIdFor,
} from "../tools/bash.ts";
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

/** Above this many tokens of context, a run compacts before its next step (§2). */
export const compactAtTokens = 120_000;

/** Steps kept word for word after a compaction. */
export const keptSteps = 5;

/** The last message of the compaction call: the summary is due. */
export const compactNow =
  "Write the summary of this task so far now, under the headings in your instructions.";

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
// The summarizer sees the same tools (the history uses them) but can't call them.
const compactionPrompt = promptVersion("compaction", [
  bashDefinition("background"),
  viewImageDefinition,
  browserHandoffDefinition,
]);
const compactionInstructions = cacheBreakpoint({
  role: "system" as const,
  content: systemPrompts.compaction,
});

export interface BackgroundDeps {
  db: DbOrTx;
  logger: Logger;
  gateway: ModelGateway;
  vm: VmClient;
  runTokenSecret: string;
  blobs: BlobStore;
  /** The site, for handoff links (`/t/<token>`). */
  webPublicUrl: string;
  /** For tests: the pause before a quick retry. */
  retryDelayMs?: number;
  /** For tests: the context size that triggers a compaction. */
  compactAtTokens?: number;
}

/** A stored message of the run, in order. */
interface LogEntry {
  id: number;
  kind: "message" | "compaction";
  message: ModelMessage;
}

/**
 * The model's context from the run's log (§2). Without a compaction, every
 * message. After one: the brief and the latest summary as one message, the
 * last few steps before it word for word (starting at an assistant message,
 * so a tool call is never cut from its result), and everything since.
 */
export function contextOf(log: readonly LogEntry[]): ModelMessage[] {
  const at = log.findLastIndex((entry) => entry.kind === "compaction");
  const messages = (entries: readonly LogEntry[]) =>
    entries.filter((e) => e.kind === "message").map((e) => e.message);
  if (at === -1) return messages(log);
  const brief = log[0]?.message.content;
  const summary = log[at]?.message.content;
  const before = messages(log.slice(1, at));
  const starts = before.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  const from = starts[Math.max(0, starts.length - keptSteps)] ?? before.length;
  return [
    {
      role: "user",
      content: `${typeof brief === "string" ? brief : JSON.stringify(brief)}\n\n<summary_of_earlier_work>\n${typeof summary === "string" ? summary : JSON.stringify(summary)}\n</summary_of_earlier_work>\nThe steps after this summary are shown as they happened.`,
    },
    ...before.slice(from),
    ...messages(log.slice(at + 1)),
  ];
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
    /** What started it: the front of house delegating, or a trigger. */
    triggerType?: "delegate" | "schedule" | "event" | "expire";
    triggerId?: string;
    /** The front-of-house turn that delegated it. */
    parentRunId?: string;
    /**
     * The first message's content instead of the brief in a `<task>` element
     * (a trigger's note, events and the conversation tail). Gets the start time.
     */
    message?: (startedAt: string) => string;
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
      triggerId: options.triggerId,
      parentRunId: options.parentRunId,
    });
    const startedAt = formatEnvelopeTime(new Date(), user.timeZone);
    const message: ModelMessage = {
      role: "user",
      content: options.message
        ? options.message(startedAt)
        : `<task started_at="${startedAt}">\n${options.brief}\n</task>`,
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
    .select({
      id: runMessages.id,
      kind: runMessages.kind,
      content: runMessages.content,
    })
    .from(runMessages)
    .where(eq(runMessages.runId, runId))
    .orderBy(asc(runMessages.seq));
  const log: LogEntry[] = stored.map((row) => ({
    id: row.id,
    kind: row.kind,
    message: row.content as ModelMessage,
  }));
  let messages = contextOf(log);
  /** Where the context starts in the log: the latest compaction, or the brief. */
  const contextStart = () =>
    log.findLast((entry) => entry.kind === "compaction")?.id ?? log[0]?.id ?? 0;
  const lastStoredId = () => log.at(-1)?.id ?? 0;
  const store = async (
    message: ModelMessage,
    kind: LogEntry["kind"] = "message",
  ) => {
    signal?.throwIfAborted();
    const [row] = await db
      .insert(runMessages)
      .values({
        runId,
        seq: log.length,
        kind,
        role: message.role,
        content: message,
      })
      .returning({ id: runMessages.id });
    if (!row) throw new Error("Storing a run message returned no row.");
    log.push({ id: row.id, kind, message });
    messages = contextOf(log);
  };

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

  /**
   * What an interrupted tool call returns: a command's real result if the VM
   * still has it (it never runs an exec id twice), a fresh look for
   * `view_image` (it only reads), and otherwise "unknown".
   */
  const recover = async (
    call: ToolCallPart,
  ): Promise<ToolResultPart["output"]> => {
    if (call.toolName === "bash") {
      const result = await deps.vm
        .fetchExec(run.userId, execIdFor(runId, call.toolCallId))
        .catch(() => undefined);
      if (result)
        return {
          type: "text",
          value: await bashOutput(
            {
              vm: deps.vm,
              logger,
              run: { runId, userId: run.userId, kind: "background" },
            },
            result,
            call.toolCallId,
          ),
        };
    }
    if (call.toolName === "view_image")
      return runTool(tools, call, messages, false, signal);
    return { type: "text", value: interruptedNote };
  };

  /**
   * The run's browser window, held for the user while it's parked (§5), for
   * a live-view link; undefined when it has none or the VM can't be reached.
   */
  const heldWindow = async () => {
    try {
      const window = await deps.vm.holdBrowser(run.userId, runId);
      return window
        ? { ...window, webPublicUrl: deps.webPublicUrl }
        : undefined;
    } catch (error) {
      logger.warn({ err: error }, "holding the browser for a handoff failed");
      return undefined;
    }
  };

  // A step that died after the model asked for tools (§9, crash safety).
  const lastEntry = log.at(-1);
  const unanswered =
    lastEntry?.kind === "message"
      ? unansweredToolCalls([lastEntry.message])
      : [];
  if (unanswered.length > 0) {
    logger.warn(
      { calls: unanswered.length },
      "resuming after an interrupted step",
    );
    const handoff = unanswered.find((call) => call.toolName === handoffTool);
    if (handoff) {
      await parkTask(
        db,
        runId,
        reasonOf(handoff),
        run.stepCount,
        await heldWindow(),
      );
      return "parked";
    }
    const recovered = [];
    for (const call of unanswered)
      recovered.push({ call, output: await recover(call) });
    await store(toolMessage(recovered));
  }

  // The last call: cancelled, or at the step cap. No tools, just the report.
  const cancelling = run.cancelRequestedAt !== null;
  const capped = !cancelling && run.stepCount >= maxStepsPerRun - 1;
  const last = cancelling || capped;
  if (cancelling) await store({ role: "user", content: cancelNote });
  else if (capped) await store({ role: "user", content: capNote });

  /** One model call with quick retries on transient errors. */
  const generate = async (options: {
    prompt: typeof prompt;
    instructions: typeof instructions;
    messages: ModelMessage[];
    noTools: boolean;
  }) => {
    for (let retry = 0; ; retry += 1) {
      try {
        return await gateway.generate({
          profile: "background",
          ...(run.effort ? { effort: run.effort } : {}),
          run: {
            runId,
            userId: run.userId,
            prompt: options.prompt,
            contextRange: () => ({
              fromMessageId: contextStart(),
              toMessageId: lastStoredId(),
            }),
          },
          stepOffset: run.stepCount,
          instructions: options.instructions,
          messages: withRollingBreakpoint(
            await rehydrateImages(options.messages, deps.blobs),
          ),
          tools: requests,
          ...(options.noTools ? { toolChoice: "none" as const } : {}),
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
  const call = () =>
    generate({ prompt, instructions, messages, noTools: last });

  // A long run summarizes itself before going on (§2, Background-run compaction).
  if (
    (await contextTokens(db, runId)) > (deps.compactAtTokens ?? compactAtTokens)
  ) {
    const compacted = await generate({
      prompt: compactionPrompt,
      instructions: compactionInstructions,
      messages: [...messages, { role: "user", content: compactNow }],
      noTools: true,
    });
    const summary = compacted.finalStep.text.trim();
    if (!summary) throw new Error("The compaction's summary came back empty.");
    await store({ role: "user", content: summary }, "compaction");
    logger.info({ messages: messages.length }, "compacted the run's context");
  }

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
    if (!report && !last && !log.some((entry) => isNudge(entry.message))) {
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
    await parkTask(
      db,
      runId,
      reasonOf(handoff),
      run.stepCount + 1,
      await heldWindow(),
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

/**
 * About how big the run's context is: what its latest step saw and wrote,
 * exact and free. Right after a compaction it's 0, since that call saw the
 * old, long context.
 */
async function contextTokens(db: DbOrTx, runId: string) {
  const [latest] = await db
    .select({
      input: modelCalls.inputTokens,
      output: modelCalls.outputTokens,
      promptHash: modelCalls.promptHash,
    })
    .from(modelCalls)
    .where(eq(modelCalls.runId, runId))
    .orderBy(desc(modelCalls.id))
    .limit(1);
  if (!latest || latest.promptHash === compactionPrompt.hash) return 0;
  return latest.input + latest.output;
}

/** The handoff's reason, as the model gave it. */
function reasonOf(call: ToolCallPart) {
  const { reason } = call.input as { reason?: unknown };
  return typeof reason === "string" && reason.trim()
    ? reason.trim()
    : "The task needs the user to take over.";
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
