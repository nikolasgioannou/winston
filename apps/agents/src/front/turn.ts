/**
 * One front-of-house turn (docs/design.md §1, §4, §16): everything the user
 * sent since the last turn becomes one envelope message, the model runs over
 * the conversation one step at a time, and every step is appended to
 * `run_messages`. Replies are streamed: whatever the model writes in a step
 * is sent to the user as soon as the step's model call ends, before its tool
 * calls run, so messages and actions reach the user in the order they were
 * written. `end_turn` ends the turn; called without text, it's silence.
 *
 * Steering: input that arrives mid-turn is claimed before the next model
 * call. A step's text is sent only if nothing new arrived while it was
 * written. Otherwise it isn't sent, its tool calls don't run, and the model
 * continues with the new input in view.
 */
import {
  createHandoff,
  browserLink,
  resolveFrontHandoffs,
} from "@winston/db/handoffs";
import type { DbOrTx } from "@winston/db/client";
import {
  frontState,
  inboundItems,
  outboundMessages,
  runMessages,
  runs,
  telegramLinks,
  users,
} from "@winston/db/schema";
import {
  renderAttachmentContent,
  renderBatch,
  type EnvelopeItem,
} from "@winston/domain/envelope";
import { promptVersion, systemPrompts } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import {
  APICallError,
  isStepCount,
  type LanguageModelCallEndEvent,
  type ModelMessage,
  type Tool,
  type UserContent,
} from "ai";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  notExists,
  sql,
} from "drizzle-orm";
import { cacheBreakpoint, withRollingBreakpoint } from "../model/cache.ts";
import {
  modelProfiles,
  type ModelGateway,
  type ModelProfile,
} from "../model/gateway.ts";
import { storableMessage, type BlobStore } from "../blobs.ts";
import { attachDefinition, attachTool } from "../tools/attach.ts";
import { bashDefinition, bashTool } from "../tools/bash.ts";
import { startBackgroundRun } from "../background/run.ts";
import { delegateDefinition, delegateTool } from "../tools/delegate.ts";
import {
  browserHandoffDefinition,
  frontHandoffTool,
} from "../tools/handoff.ts";
import { viewImageDefinition, viewImageTool } from "../tools/view-image.ts";
import type { VmClient } from "../vm/gateway-client.ts";
import { startTyping, type Timers } from "../telegram/typing.ts";
import { toEnvelopeItems } from "@winston/db/envelopes";
import {
  defaultWindowBudget,
  shortened,
  trimWindow,
  type WindowBudget,
} from "./window.ts";
import {
  deliverReply,
  endTurnDefinition,
  endTurnTool,
  type TelegramSender,
} from "./reply.ts";

/** Most model calls in one turn (§1, "Per-turn step budget"). */
export const frontStepBudget = 15;

/** Added before the turn's last step, so the front of house hands the rest over itself. */
export const budgetNote =
  "This is the last step of this turn. If the work isn't finished, hand the rest to a background agent now: call `delegate` with a brief covering the goal, what you've done, where things stand and what's left, and tell the user in a line that you're carrying on in the background.";

/** Asks for a brief when the last step didn't hand over. Not stored. */
export const briefRequest =
  "Write a self-contained brief for a background agent to finish what you were doing: the goal, what's been done, where things stand, what's left, and anything the user approved, word for word. Write only the brief.";

/** Sent when the turn ran out of steps and the server handed the rest over. */
export const budgetFallbackNote =
  "This is taking longer than I expected, so I'm carrying on in the background. I'll let you know when it's done.";

/**
 * Added once when a turn ends having sent nothing, without `end_turn`. Anthropic's
 * advice for an empty response is a new user message, not a plain retry.
 */
export const emptyReplyNudge = "Please continue.";

/** Quick retries on the front model after a transient error, before falling back (§6). */
export const frontRetries = 2;

/** Each model call's time limit, so a hung request can't hold the user's turn. */
export const frontCallTimeoutMs = 90_000;

/** Sent, without a model, when every attempt failed. At most once until a turn succeeds. */
export const outageNotice =
  "I'm having trouble thinking right now; I'll reply as soon as I'm back.";

/** Sent, without a model, when both models refused. */
export const refusalReply = "Sorry, I can't help with that one.";

/** Leads the new input when a step's message was dropped for it. */
export const messageDroppedNote =
  "Your last message was not sent, and the tools you called with it didn't run: new messages arrived while you wrote it.";

/** What a tool call in a dropped step returns instead of running. */
const notRun =
  "Not run: new messages arrived before this step's message was sent.";

// Tools in the order the model sees them; the prompt version hashes them in that order.
const prompt = promptVersion("front-of-house", [
  bashDefinition("front"),
  viewImageDefinition,
  attachDefinition,
  delegateDefinition,
  browserHandoffDefinition,
  endTurnDefinition,
]);
const instructions = cacheBreakpoint(
  { role: "system" as const, content: systemPrompts["front-of-house"] },
  modelProfiles.front.cacheTtl,
);

export interface FrontTurnDeps {
  db: DbOrTx;
  logger: Logger;
  gateway: ModelGateway;
  telegram: TelegramSender;
  /** The user's computer, through the gateway. */
  vm: VmClient;
  /** Signs the run tokens `bash` hands to commands. */
  runTokenSecret: string;
  /** Where images from tool results are kept, instead of inline in `run_messages`. */
  blobs: BlobStore;
  /** The site, for links to the browser page (`/browser?window=…`). */
  webPublicUrl: string;
  /** For tests: the typing indicator's timers. */
  timers?: Timers;
  /** The rolling window's size; the defaults suit production. */
  window?: WindowBudget;
  /** For tests: the pause before a quick retry. */
  retryDelayMs?: number;
  /** For tests: each model call's time limit. */
  callTimeoutMs?: number;
}

/** Runs a turn over the user's unconsumed input. Returns the run id, or nothing if there was no input. */
export async function runFrontTurn(deps: FrontTurnDeps, userId: string) {
  const { db, gateway, telegram } = deps;
  const [user] = await db
    .select({ timezone: users.timezone, chatId: telegramLinks.chatId })
    .from(users)
    .innerJoin(telegramLinks, eq(telegramLinks.userId, users.id))
    .where(eq(users.id, userId));
  if (!user) {
    deps.logger.warn({ userId }, "no linked Telegram chat; skipping turn");
    return undefined;
  }

  const [run] = await db.transaction(async (tx) => {
    await recoverAbandonedRuns(tx, userId);
    // Claim first: no run is created unless there's input to answer.
    const items = await lockUnconsumed(tx, userId);
    if (items.length === 0) return [];
    const [created] = await tx.insert(runs).values({ userId }).returning();
    if (!created) throw new Error("Creating a run returned no row.");
    const log = new RunLog(created.id);
    const input = await log.claim(tx, userId, items, user.timezone, deps.blobs);
    // The user wrote: a window the front of house handed them is Winston's
    // again ("done" is their next message, §5). The page keeps showing it.
    const handedBack = items.some((item) => item.type === "user_message")
      ? await resolveFrontHandoffs(tx, userId)
      : [];
    return [{ log, input, handedBack }];
  });
  if (!run) return undefined;
  const { log, input, handedBack } = run;
  const runId = log.runId;
  const logger = deps.logger.child({ runId });
  for (const { windowId } of handedBack)
    deps.vm
      .releaseBrowser(userId, "front", windowId)
      .catch((error: unknown) => {
        logger.warn({ err: error }, "releasing the handed-over browser failed");
      });
  // "Typing…" shows work between messages (§4).
  const typing = startTyping(
    () => telegram.sendChatAction(user.chatId, "typing"),
    logger,
    deps.timers,
  );

  await trimWindow(
    db,
    userId,
    systemPrompts["front-of-house"],
    deps.window ?? defaultWindowBudget,
    logger,
  );
  const { rows: window, stubBefore } = await loadWindow(db, userId, input.id);
  const messages: ModelMessage[] = [
    ...window.map((row) => row.content),
    input.message,
  ];

  /** Claims input that arrived mid-turn and appends it, led by `note` if given. */
  const steerIn = async (note?: string) => {
    const claimed = await db.transaction(async (tx) => {
      const items = await lockUnconsumed(tx, userId);
      return items.length === 0
        ? undefined
        : log.claim(tx, userId, items, user.timezone, deps.blobs, note);
    });
    if (claimed) messages.push(claimed.message);
    return claimed !== undefined;
  };

  let steps = 0;
  /** Whether a handoff went through (a blank window is refused instead). */
  const handoff = { done: false };
  const bash = bashTool({
    vm: deps.vm,
    logger,
    runTokenSecret: deps.runTokenSecret,
    run: { runId, userId, kind: "front" },
  });
  const viewImage = viewImageTool({ vm: deps.vm, logger, userId });

  // Streamed replies (§4): a step's text goes out as soon as its model call
  // ends, before its tools run, unless new input arrived meanwhile. Then the
  // step is dropped: nothing is sent and its tools return `notRun`.
  // Mutated from the SDK callback, so kept in an object TypeScript won't narrow.
  const stream = {
    sent: 0,
    dropStep: false,
    deliveryError: undefined as Error | undefined,
  };
  const deliverStepText = async ({
    content,
    finishReason,
  }: LanguageModelCallEndEvent) => {
    stream.dropStep = false;
    // A refusal arrives as "other"; its output is never sent.
    if (finishReason !== "stop" && finishReason !== "tool-calls") return;
    const text = content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim();
    if (!text) return;
    if (await hasClaimableInput(db, userId)) {
      stream.dropStep = true;
      return;
    }
    try {
      await deliverReply({
        db,
        logger,
        telegram,
        userId,
        runId,
        chatId: user.chatId,
        text,
        webPublicUrl: deps.webPublicUrl,
      });
      stream.sent += 1;
    } catch (error) {
      // The SDK swallows callback errors; the loop rethrows this after the step.
      stream.deliveryError =
        error instanceof Error ? error : new Error(String(error));
    }
  };
  const tools = {
    bash: unlessDropped(bash, () => stream.dropStep),
    view_image: unlessDropped(viewImage, () => stream.dropStep),
    attach: unlessDropped(
      attachTool({
        db,
        vm: deps.vm,
        telegram,
        logger,
        userId,
        runId,
        chatId: user.chatId,
      }),
      () => stream.dropStep,
    ),
    delegate: unlessDropped(
      delegateTool({ db, logger, vm: deps.vm, userId, runId }),
      () => stream.dropStep,
    ),
    browser_handoff: unlessDropped(
      frontHandoffTool({
        hold: () => deps.vm.holdBrowser(userId, "front"),
        release: () => deps.vm.releaseBrowser(userId, "front"),
        handedOver: () => {
          handoff.done = true;
        },
        createLink: async (window, reason) => {
          await createHandoff(db, {
            runId,
            userId,
            windowId: window.windowId,
            targetId: window.targetId,
            reason,
          });
          return browserLink(deps.webPublicUrl, window.windowId);
        },
        sendLink: (text) =>
          deliverReply({
            db,
            logger,
            telegram,
            userId,
            runId,
            chatId: user.chatId,
            text,
            webPublicUrl: deps.webPublicUrl,
          }),
        logger,
      }),
      () => stream.dropStep,
    ),
    end_turn: unlessDropped(endTurnTool, () => stream.dropStep),
  };
  const attempt = async (profile: ModelProfile) => {
    try {
      return await gateway.generate({
        profile,
        run: {
          runId,
          userId,
          prompt,
          contextRange: () => ({
            fromMessageId: window[0]?.id ?? input.id,
            toMessageId: log.lastStoredId,
            stubBeforeMessageId: stubBefore,
          }),
        },
        stepOffset: steps,
        instructions,
        messages: withRollingBreakpoint(messages, modelProfiles.front.cacheTtl),
        tools,
        stopWhen: isStepCount(1),
        onLanguageModelCallEnd: deliverStepText,
        timeout: deps.callTimeoutMs ?? frontCallTimeoutMs,
      });
    } finally {
      steps += 1;
    }
  };

  /**
   * One model step with the failure policy (§6): quick retries on transient
   * errors, then one attempt on the fallback model. A refusal also goes to
   * the fallback once. Throws if every attempt failed.
   */
  const callModel = async () => {
    for (let retry = 0; ; retry += 1) {
      try {
        const result = await attempt("front");
        if (!isRefusal(result)) return result;
        logger.warn("the front model refused; trying the fallback");
        break;
      } catch (error) {
        if (!isTransient(error) || retry >= frontRetries) {
          logger.warn(
            { err: error },
            "the front model failed; trying the fallback",
          );
          break;
        }
        logger.warn(
          { err: error, retry: retry + 1 },
          "transient model error; retrying",
        );
        await sleep(deps.retryDelayMs ?? 500);
      }
    }
    const result = await attempt("frontFallback");
    return isRefusal(result) ? "refused" : result;
  };

  let nudged = false;
  let droppedNote: string | undefined;
  let budgetNoted = false;
  let lastStepDelegated = false;
  let outcome:
    "reply" | "silent" | "empty" | "refused" | "delegated" | "unfinished" =
    "unfinished";
  try {
    while (steps < frontStepBudget) {
      // Before the last step, ask the model to hand the rest over (§1).
      const lastStep = steps >= frontStepBudget - 1 && !budgetNoted;
      if (steps > 0) {
        const note = [droppedNote, lastStep ? budgetNote : undefined]
          .filter(Boolean)
          .join("\n\n");
        const steered = await steerIn(note || undefined);
        if (lastStep && !steered) {
          const ask: ModelMessage = { role: "user", content: budgetNote };
          messages.push(ask);
          await log.store(db, ask);
        }
      }
      if (lastStep) budgetNoted = true;
      droppedNote = undefined;
      const result = await callModel();

      if (result === "refused") {
        // The refused output is never kept; the user gets a plain answer.
        const reply: ModelMessage = {
          role: "assistant",
          content: refusalReply,
        };
        messages.push(reply);
        await log.store(db, reply);
        await deliverReply({
          db,
          logger,
          telegram,
          userId,
          runId,
          chatId: user.chatId,
          text: refusalReply,
        });
        outcome = "refused";
        break;
      }
      // Images go to blob storage; the stored message keeps a stub.
      for (const message of result.responseMessages)
        await log.store(db, await storableMessage(message, deps.blobs));
      messages.push(...result.responseMessages);
      if (stream.deliveryError) throw stream.deliveryError;
      const step = result.finalStep;
      lastStepDelegated = step.toolCalls.some(
        (call) => call.toolName === "delegate",
      );

      if (stream.dropStep) {
        logger.info(
          "new input arrived; the step's message wasn't sent and its tools didn't run",
        );
        droppedNote = messageDroppedNote;
        continue;
      }
      // A handoff ends the turn too: the user's reply is the next message (§1).
      if (
        handoff.done ||
        step.toolCalls.some((call) => call.toolName === "end_turn")
      ) {
        outcome = stream.sent > 0 ? "reply" : "silent";
        break;
      }
      // Other tool calls continue the loop with their results.
      if (step.toolCalls.length > 0) continue;
      // Text with no tool calls was sent and ends the turn, as does an empty
      // step after earlier messages.
      if (stream.sent > 0) {
        outcome = "reply";
        break;
      }
      if (nudged) {
        outcome = "empty";
        break;
      }
      // A glitch, not silence: silence is always an explicit `end_turn`.
      logger.warn("turn ended without sending anything; nudging once");
      nudged = true;
      const nudge: ModelMessage = { role: "user", content: emptyReplyNudge };
      messages.push(nudge);
      await log.store(db, nudge);
    }

    // Out of steps with work left: the model handed it over on its last
    // step, or the server does it with a brief the model writes.
    if (outcome === "unfinished") {
      if (!lastStepDelegated) {
        const brief = await gateway.generate({
          profile: "front",
          run: {
            runId,
            userId,
            prompt,
            contextRange: () => ({
              fromMessageId: window[0]?.id ?? input.id,
              toMessageId: log.lastStoredId,
              stubBeforeMessageId: stubBefore,
            }),
          },
          stepOffset: steps,
          instructions,
          messages: withRollingBreakpoint(
            [...messages, { role: "user", content: briefRequest }],
            modelProfiles.front.cacheTtl,
          ),
          tools,
          toolChoice: "none",
          stopWhen: isStepCount(1),
          timeout: deps.callTimeoutMs ?? frontCallTimeoutMs,
        });
        steps += 1;
        const taskId = await startBackgroundRun(db, {
          userId,
          brief: brief.finalStep.text.trim() || briefRequest,
          triggerType: "delegate",
          parentRunId: runId,
        });
        await deliverReply({
          db,
          logger,
          telegram,
          userId,
          runId,
          chatId: user.chatId,
          text: budgetFallbackNote,
        });
        const said: ModelMessage = {
          role: "assistant",
          content: budgetFallbackNote,
        };
        messages.push(said);
        await log.store(db, said);
        logger.info({ taskId }, "out of steps; handed the rest over");
      }
      outcome = "delegated";
    }
    if (outcome === "empty")
      logger.error("turn ended with an empty reply twice; nothing sent");
    await finishRun(db, runId, "completed", steps);
    logger.info({ steps, outcome }, "turn completed");
    return runId;
  } catch (error) {
    // Every attempt failed. The input goes back to unconsumed, so the next
    // turn that works answers it; the job's own retry brings that turn.
    await finishRun(db, runId, "failed", steps);
    await releaseInput(db, runId);
    if (!(await outageNoticePending(db, userId))) {
      await deliverReply({
        db,
        logger,
        telegram,
        userId,
        runId,
        chatId: user.chatId,
        text: outageNotice,
      }).catch((noticeError: unknown) => {
        logger.error({ err: noticeError }, "sending the outage notice failed");
      });
    }
    throw error;
  } finally {
    typing.stop();
  }
}

/**
 * A tool that returns `notRun` instead of running while `dropped()` is true,
 * so a dropped step still gets a result for every call.
 */
function unlessDropped<T extends Tool>(tool: T, dropped: () => boolean): T {
  const { execute, toModelOutput } = tool;
  if (!execute) return tool;
  const skipped = { notRun } as const;
  return {
    ...tool,
    execute: (input: never, options: never): unknown =>
      dropped() ? skipped : execute(input, options),
    toModelOutput: (options: never) =>
      (options as { output: unknown }).output === skipped
        ? { type: "text", value: notRun }
        : toModelOutput
          ? toModelOutput(options)
          : typeof (options as { output: unknown }).output === "string"
            ? { type: "text", value: (options as { output: unknown }).output }
            : { type: "json", value: (options as { output: unknown }).output },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Anthropic's refusal, which the AI SDK reports as `other` with the raw reason. */
function isRefusal(result: {
  finalStep: { rawFinishReason: string | undefined };
}) {
  return result.finalStep.rawFinishReason === "refusal";
}

/** Worth a quick retry: rate limits, server errors, timeouts, dropped connections. */
function isTransient(error: unknown) {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Hands a failed turn's input back, so the next turn answers it. */
async function releaseInput(db: DbOrTx, runId: string) {
  await db
    .update(inboundItems)
    .set({ consumedByRunId: null })
    .where(eq(inboundItems.consumedByRunId, runId));
}

/**
 * While this user's lock is held, any other `running` run is dead (its worker
 * crashed). Mark it failed and hand its input back.
 */
async function recoverAbandonedRuns(tx: DbOrTx, userId: string) {
  const dead = await tx
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()` })
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.kind, "front"),
        eq(runs.status, "running"),
      ),
    )
    .returning({ id: runs.id });
  if (dead.length > 0)
    await tx
      .update(inboundItems)
      .set({ consumedByRunId: null })
      .where(
        inArray(
          inboundItems.consumedByRunId,
          dead.map((run) => run.id),
        ),
      );
}

/** True if the outage notice went out and no turn has succeeded since. */
async function outageNoticePending(db: DbOrTx, userId: string) {
  const [notice] = await db
    .select({ sentAt: outboundMessages.sentAt })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.userId, userId),
        eq(outboundMessages.text, outageNotice),
      ),
    )
    .orderBy(desc(outboundMessages.sentAt))
    .limit(1);
  if (!notice) return false;
  const [recovered] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.kind, "front"),
        eq(runs.status, "completed"),
        gt(runs.finishedAt, notice.sentAt),
      ),
    )
    .limit(1);
  return recovered === undefined;
}

/** A run's append-only message log: positions and the last stored id. */
class RunLog {
  private seq = 0;
  lastStoredId = 0;

  constructor(readonly runId: string) {}

  async store(db: DbOrTx, message: ModelMessage) {
    const [stored] = await db
      .insert(runMessages)
      .values({
        runId: this.runId,
        seq: this.seq,
        role: message.role,
        content: message,
      })
      .returning({ id: runMessages.id });
    if (!stored) throw new Error("Storing a run message returned no row.");
    this.seq += 1;
    this.lastStoredId = stored.id;
    return stored.id;
  }

  /**
   * Stores locked inbound items as one envelope message and marks them
   * consumed by this run, in the caller's transaction: items are consumed
   * exactly once.
   */
  async claim(
    tx: DbOrTx,
    userId: string,
    items: InboundItem[],
    timeZone: string,
    blobs: BlobStore,
    note?: string,
  ) {
    const envelopeItems = await toEnvelopeItems(tx, userId, items);
    const envelopes = renderBatch(envelopeItems, timeZone);
    const text = note ? `${note}\n\n${envelopes}` : envelopes;
    const shown = await shownFiles(envelopeItems, blobs);
    // The model sees the files now; the stored message keeps stubs (§2).
    const message: ModelMessage =
      shown.length === 0
        ? { role: "user", content: text }
        : {
            role: "user",
            content: [
              { type: "text", text },
              ...shown.flatMap((file) => file.parts),
            ],
          };
    const stored: ModelMessage =
      shown.length === 0
        ? message
        : {
            role: "user",
            content: [
              { type: "text", text },
              ...shown.map((file) => ({
                type: "text" as const,
                text: file.stub,
              })),
            ],
          };
    const id = await this.store(tx, stored);
    await tx
      .update(inboundItems)
      .set({ consumedByRunId: this.runId })
      .where(
        inArray(
          inboundItems.id,
          items.map((item) => item.id),
        ),
      );
    return { id, message };
  }
}

type InboundItem = typeof inboundItems.$inferSelect;

/**
 * The files sent with these messages that the model reads directly (§4,
 * Media): images and PDFs as file parts, text as escaped text. Each has a
 * stub for the stored copy, which later turns see instead.
 */
async function shownFiles(items: readonly EnvelopeItem[], blobs: BlobStore) {
  const shown: { parts: Exclude<UserContent, string>; stub: string }[] = [];
  for (const item of items) {
    if (item.kind !== "user_message") continue;
    const { attachment } = item.payload;
    if (!attachment?.shown || !attachment.path) continue;
    const { path, shown: file } = attachment;
    const bytes = await blobs.get(file.blobKey);
    const stub = `[${path} was shown here; not shown again. Open it on your computer to see it again.]`;
    if (file.as === "text") {
      shown.push({
        parts: [
          {
            type: "text",
            text: renderAttachmentContent(
              path,
              new TextDecoder().decode(bytes),
            ),
          },
        ],
        stub,
      });
      continue;
    }
    shown.push({
      parts: [
        { type: "text", text: `${path}:` },
        {
          type: "file",
          mediaType: file.mediaType,
          filename: path.split("/").at(-1) ?? path,
          data: { type: "data", data: Buffer.from(bytes).toString("base64") },
        },
      ],
      stub,
    });
  }
  return shown;
}

/**
 * The user's input a turn can take now: unconsumed, not `pending`, and
 * older than any pending item, so a message never overtakes a file sent
 * before it.
 */
export function claimableInput(userId: string) {
  return and(
    eq(inboundItems.userId, userId),
    isNull(inboundItems.consumedByRunId),
    eq(inboundItems.pending, false),
    notExists(
      sql`(select 1 from ${inboundItems} as held
        where held.user_id = ${userId} and held.consumed_by_run_id is null and held.pending
          and (held.occurred_at, held.created_at) <= (${inboundItems.occurredAt}, ${inboundItems.createdAt}))`,
    ),
  );
}

/** Whether the user has input a turn could take now. Pending items don't count: saving their file queues a turn. */
export async function hasClaimableInput(db: DbOrTx, userId: string) {
  const [item] = await db
    .select({ id: inboundItems.id })
    .from(inboundItems)
    .where(claimableInput(userId))
    .limit(1);
  return item !== undefined;
}

/** The user's claimable inbound items, oldest first, locked for this transaction. */
async function lockUnconsumed(tx: DbOrTx, userId: string) {
  return tx
    .select()
    .from(inboundItems)
    .where(claimableInput(userId))
    .orderBy(asc(inboundItems.occurredAt), asc(inboundItems.createdAt))
    .for("update");
}

/**
 * The user's front-of-house stream from the window start, up to (not
 * including) `beforeId`, with long tool output before the stub boundary
 * shortened.
 */
async function loadWindow(db: DbOrTx, userId: string, beforeId: number) {
  const [state] = await db
    .select({
      start: frontState.windowStartMessageId,
      stubBefore: frontState.stubBeforeMessageId,
    })
    .from(frontState)
    .where(eq(frontState.userId, userId));
  const stubBefore = state?.stubBefore ?? 0;
  const rows = await db
    .select({ id: runMessages.id, content: runMessages.content })
    .from(runMessages)
    .innerJoin(runs, eq(runs.id, runMessages.runId))
    .where(
      and(
        eq(runs.userId, userId),
        // Background runs keep their own transcripts (§2).
        eq(runs.kind, "front"),
        // Failed runs stay in the database as the record, never in context.
        eq(runs.status, "completed"),
        gte(runMessages.id, state?.start ?? 0),
        lt(runMessages.id, beforeId),
      ),
    )
    .orderBy(asc(runMessages.id));
  // Stored as the AI SDK returned them.
  return {
    rows: rows.map((row) => {
      const message = row.content as ModelMessage;
      return {
        id: row.id,
        content: row.id < stubBefore ? shortened(message) : message,
      };
    }),
    stubBefore,
  };
}

async function finishRun(
  db: DbOrTx,
  runId: string,
  status: "completed" | "failed",
  stepCount: number,
) {
  await db
    .update(runs)
    .set({ status, stepCount, finishedAt: sql`now()` })
    .where(eq(runs.id, runId));
}
