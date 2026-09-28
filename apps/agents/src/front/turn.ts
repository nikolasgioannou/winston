/**
 * One front-of-house turn (docs/design.md §1, §4, §16): everything the user
 * sent since the last turn becomes one envelope message, the model runs over
 * the conversation one step at a time, and every step is appended to
 * `run_messages`. The final text (the last step's, with no tool calls) is the
 * reply. Calling `no_reply` ends the turn in silence. Text written alongside
 * tool calls is never sent.
 *
 * Steering: input that arrives mid-turn is claimed before the next model
 * call, and a drafted reply is sent only if nothing new arrived while it was
 * written. Otherwise the draft is dropped and the model writes one reply
 * covering everything.
 */
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
  type ModelMessage,
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
import { cacheBreakpoint } from "../model/cache.ts";
import type { ModelGateway, ModelProfile } from "../model/gateway.ts";
import { storableMessage, type BlobStore } from "../blobs.ts";
import { bashDefinition, bashTool } from "../tools/bash.ts";
import { viewImageDefinition, viewImageTool } from "../tools/view-image.ts";
import type { VmClient } from "../vm/gateway-client.ts";
import { startTyping, type Timers } from "../telegram/typing.ts";
import { toEnvelopeItems } from "./envelopes.ts";
import {
  defaultWindowBudget,
  trimWindow,
  type WindowBudget,
} from "./window.ts";
import {
  deliverReply,
  noReplyDefinition,
  noReplyTool,
  type TelegramSender,
} from "./reply.ts";

/** Most model calls in one turn (§1, "Per-turn step budget"). */
export const frontStepBudget = 15;

/**
 * Added once when a turn ends with neither a reply nor `no_reply`. Anthropic's
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

/** Leads the new input when a drafted reply was dropped for it. */
export const draftDroppedNote =
  "Your last reply was not sent: new messages arrived while you wrote it. Reply once, covering everything.";

// Tools in the order the model sees them; the prompt version hashes them in that order.
const prompt = promptVersion("front-of-house", [
  bashDefinition("front"),
  viewImageDefinition,
  noReplyDefinition,
]);
const instructions = cacheBreakpoint({
  role: "system" as const,
  content: systemPrompts["front-of-house"],
});

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
  /** For tests: the typing indicator's timers. */
  timers?: Timers;
  /** The rolling window's size; the defaults suit production. */
  window?: WindowBudget;
  /** For tests: the pause before a quick retry. */
  retryDelayMs?: number;
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
    return [{ log, input }];
  });
  if (!run) return undefined;
  const { log, input } = run;
  const runId = log.runId;
  const logger = deps.logger.child({ runId });
  // Replies aren't streamed, so "typing…" is the only sign of work (§4).
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
  const window = await loadWindow(db, userId, input.id);
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
  const bash = bashTool({
    vm: deps.vm,
    logger,
    runTokenSecret: deps.runTokenSecret,
    run: { runId, userId, kind: "front" },
  });
  const viewImage = viewImageTool({ vm: deps.vm, logger, userId });
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
          }),
        },
        stepOffset: steps,
        instructions,
        messages: withRollingBreakpoint(messages),
        tools: { bash, view_image: viewImage, no_reply: noReplyTool },
        stopWhen: isStepCount(1),
        timeout: frontCallTimeoutMs,
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
  let outcome: "reply" | "silent" | "empty" | "refused" | "unfinished" =
    "unfinished";
  try {
    while (steps < frontStepBudget) {
      if (steps > 0) await steerIn();
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
      const step = result.finalStep;

      if (step.toolCalls.some((call) => call.toolName === "no_reply")) {
        outcome = "silent";
        break;
      }
      // Tool calls (beyond no_reply) continue the loop with their results.
      if (step.toolCalls.length > 0) continue;

      const text = step.text.trim();
      if (!text) {
        if (nudged) {
          outcome = "empty";
          break;
        }
        // A glitch, not silence: silence is always an explicit `no_reply`.
        logger.warn("turn ended with an empty reply; nudging once");
        nudged = true;
        const nudge: ModelMessage = { role: "user", content: emptyReplyNudge };
        messages.push(nudge);
        await log.store(db, nudge);
        continue;
      }

      // Send only if nothing new arrived while the reply was written.
      if (await steerIn(draftDroppedNote)) {
        logger.info("new input arrived; dropping the draft reply");
        continue;
      }
      await deliverReply({
        db,
        logger,
        telegram,
        userId,
        runId,
        chatId: user.chatId,
        text,
      });
      outcome = "reply";
      break;
    }

    if (outcome === "empty")
      logger.error("turn ended with an empty reply twice; nothing sent");
    else if (outcome === "unfinished")
      logger.warn("turn hit the step budget before replying");
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
 * Marks the request's last message (new input, or a tool result) as the
 * rolling cache breakpoint, so each request caches everything up to itself
 * and the next one reads it back (§16). Only the request copy is marked.
 */
function withRollingBreakpoint(messages: readonly ModelMessage[]) {
  const last = messages.at(-1);
  if (!last || last.role === "assistant") return [...messages];
  return [...messages.slice(0, -1), cacheBreakpoint(last)];
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
    .where(and(eq(runs.userId, userId), eq(runs.status, "running")))
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

/** The user's claimable inbound items, oldest first, locked for this transaction. */
async function lockUnconsumed(tx: DbOrTx, userId: string) {
  return tx
    .select()
    .from(inboundItems)
    .where(claimableInput(userId))
    .orderBy(asc(inboundItems.occurredAt), asc(inboundItems.createdAt))
    .for("update");
}

/** The user's front-of-house stream from the window start, up to (not including) `beforeId`. */
async function loadWindow(db: DbOrTx, userId: string, beforeId: number) {
  const [state] = await db
    .select({ start: frontState.windowStartMessageId })
    .from(frontState)
    .where(eq(frontState.userId, userId));
  const rows = await db
    .select({ id: runMessages.id, content: runMessages.content })
    .from(runMessages)
    .innerJoin(runs, eq(runs.id, runMessages.runId))
    .where(
      and(
        eq(runs.userId, userId),
        // Failed runs stay in the database as the record, never in context.
        eq(runs.status, "completed"),
        gte(runMessages.id, state?.start ?? 0),
        lt(runMessages.id, beforeId),
      ),
    )
    .orderBy(asc(runMessages.id));
  // Stored as the AI SDK returned them.
  return rows.map((row) => ({
    id: row.id,
    content: row.content as ModelMessage,
  }));
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
