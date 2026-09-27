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
  runMessages,
  runs,
  telegramLinks,
  users,
} from "@winston/db/schema";
import { renderBatch } from "@winston/domain/envelope";
import { promptVersion, systemPrompts } from "@winston/prompts";
import type { Logger } from "@winston/shared/logger";
import { isStepCount, type ModelMessage } from "ai";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { cacheBreakpoint } from "../model/cache.ts";
import type { ModelGateway } from "../model/gateway.ts";
import { startTyping, type Timers } from "../telegram/typing.ts";
import { toEnvelopeItems } from "./envelopes.ts";
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

/** Leads the new input when a drafted reply was dropped for it. */
export const draftDroppedNote =
  "Your last reply was not sent: new messages arrived while you wrote it. Reply once, covering everything.";

const prompt = promptVersion("front-of-house", [noReplyDefinition]);
const instructions = cacheBreakpoint({
  role: "system" as const,
  content: systemPrompts["front-of-house"],
});

export interface FrontTurnDeps {
  db: DbOrTx;
  logger: Logger;
  gateway: ModelGateway;
  telegram: TelegramSender;
  /** For tests: the typing indicator's timers. */
  timers?: Timers;
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
    // Claim first: no run is created unless there's input to answer.
    const items = await lockUnconsumed(tx, userId);
    if (items.length === 0) return [];
    const [created] = await tx.insert(runs).values({ userId }).returning();
    if (!created) throw new Error("Creating a run returned no row.");
    const log = new RunLog(created.id);
    const input = await log.claim(tx, userId, items, user.timezone);
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

  const window = await loadWindow(db, userId, input.id);
  const previous = window.map((row) => row.content);
  const last = previous.at(-1);
  // The rolling cache breakpoint: the end of the previous turn.
  if (last) previous[previous.length - 1] = cacheBreakpoint(last);
  const messages: ModelMessage[] = [...previous, input.message];

  /** Claims input that arrived mid-turn and appends it, led by `note` if given. */
  const steerIn = async (note?: string) => {
    const claimed = await db.transaction(async (tx) => {
      const items = await lockUnconsumed(tx, userId);
      return items.length === 0
        ? undefined
        : log.claim(tx, userId, items, user.timezone, note);
    });
    if (claimed) messages.push(claimed.message);
    return claimed !== undefined;
  };

  let steps = 0;
  let nudged = false;
  let outcome: "reply" | "silent" | "empty" | "unfinished" = "unfinished";
  try {
    while (steps < frontStepBudget) {
      if (steps > 0) await steerIn();
      const result = await gateway.generate({
        profile: "front",
        run: {
          runId,
          userId,
          prompt,
          contextRange: () => ({
            fromMessageId: window[0]?.id ?? input.id,
            toMessageId: log.lastStoredId,
          }),
        },
        instructions,
        messages,
        tools: { no_reply: noReplyTool },
        stopWhen: isStepCount(1),
        onStepEnd: async (step) => {
          for (const message of step.response.messages)
            await log.store(db, message);
          steps += 1;
        },
      });
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
    await finishRun(db, runId, "failed", steps);
    throw error;
  } finally {
    typing.stop();
  }
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
    note?: string,
  ) {
    const envelopes = renderBatch(
      await toEnvelopeItems(tx, userId, items),
      timeZone,
    );
    const message: ModelMessage = {
      role: "user",
      content: note ? `${note}\n\n${envelopes}` : envelopes,
    };
    const id = await this.store(tx, message);
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

/** The user's unconsumed inbound items, oldest first, locked for this transaction. */
async function lockUnconsumed(tx: DbOrTx, userId: string) {
  return tx
    .select()
    .from(inboundItems)
    .where(
      and(
        eq(inboundItems.userId, userId),
        isNull(inboundItems.consumedByRunId),
      ),
    )
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
