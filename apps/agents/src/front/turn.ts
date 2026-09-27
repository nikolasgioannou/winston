/**
 * One front-of-house turn (docs/design.md §1, §4, §16): everything the user
 * sent since the last turn becomes one envelope message, the model runs over
 * the conversation, and every step is appended to `run_messages`. The final
 * text (the last step's, with no tool calls) is the reply. Calling `no_reply`
 * ends the turn in silence. Text written alongside tool calls is never sent.
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
import { hasToolCall, isStepCount, type ModelMessage } from "ai";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { cacheBreakpoint } from "../model/cache.ts";
import type { ModelGateway } from "../model/gateway.ts";
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

  const started = await startTurn(db, userId, user.timezone);
  if (!started) return undefined;
  const { runId, input } = started;
  const logger = deps.logger.child({ runId });

  const window = await loadWindow(db, userId, input.id);
  const previous = window.map((row) => row.content);
  const last = previous.at(-1);
  // The rolling cache breakpoint: the end of the previous turn.
  if (last) previous[previous.length - 1] = cacheBreakpoint(last);
  let seq = 1;
  let steps = 0;
  let lastStoredId = input.id;

  const store = async (message: ModelMessage) => {
    const [stored] = await db
      .insert(runMessages)
      .values({ runId, seq, role: message.role, content: message })
      .returning({ id: runMessages.id });
    seq += 1;
    if (stored) lastStoredId = stored.id;
  };
  const messages: ModelMessage[] = [...previous, input.content];

  const runSteps = () =>
    gateway.generate({
      profile: "front",
      run: {
        runId,
        userId,
        prompt,
        contextRange: () => ({
          fromMessageId: window[0]?.id ?? input.id,
          toMessageId: lastStoredId,
        }),
      },
      instructions,
      messages,
      tools: { no_reply: noReplyTool },
      stopWhen: [isStepCount(frontStepBudget - steps), hasToolCall("no_reply")],
      onStepEnd: async (step) => {
        for (const message of step.response.messages) await store(message);
        steps += 1;
      },
    });

  try {
    let outcome = replyOf(await runSteps());
    if (outcome.kind === "empty" && steps < frontStepBudget) {
      // A glitch, not silence: silence is always an explicit `no_reply`.
      logger.warn("turn ended with an empty reply; nudging once");
      messages.push(...outcome.responseMessages);
      const nudge: ModelMessage = { role: "user", content: emptyReplyNudge };
      messages.push(nudge);
      await store(nudge);
      outcome = replyOf(await runSteps());
    }

    if (outcome.kind === "reply")
      await deliverReply({
        db,
        telegram,
        userId,
        runId,
        chatId: user.chatId,
        text: outcome.text,
      });
    else if (outcome.kind === "empty")
      logger.error("turn ended with an empty reply twice; nothing sent");
    else if (outcome.kind === "unfinished")
      logger.warn("turn hit the step budget before replying");

    await finishRun(db, runId, "completed", steps);
    logger.info({ steps, outcome: outcome.kind }, "turn completed");
    return runId;
  } catch (error) {
    await finishRun(db, runId, "failed", steps);
    throw error;
  }
}

/** The parts of a finished loop that decide what the user gets. */
interface TurnResult {
  steps: readonly { toolCalls: readonly { toolName: string }[] }[];
  finalStep: { toolCalls: readonly unknown[]; text: string };
  responseMessages: readonly ModelMessage[];
}

/** What a finished loop means for the user. */
function replyOf(result: TurnResult) {
  const silenced = result.steps.some((step) =>
    step.toolCalls.some((call) => call.toolName === "no_reply"),
  );
  if (silenced) return { kind: "silent" as const };
  const { finalStep } = result;
  if (finalStep.toolCalls.length > 0) return { kind: "unfinished" as const };
  const text = finalStep.text.trim();
  if (!text)
    return {
      kind: "empty" as const,
      responseMessages: result.responseMessages,
    };
  return { kind: "reply" as const, text };
}

/**
 * Atomically claims the user's unconsumed inbound items: creates the run,
 * stores them as its first message (one envelope batch) and marks them
 * consumed. Items are consumed exactly once, whatever happens next.
 */
async function startTurn(db: DbOrTx, userId: string, timeZone: string) {
  return db.transaction(async (tx) => {
    const items = await tx
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
    if (items.length === 0) return undefined;

    const [run] = await tx.insert(runs).values({ userId }).returning();
    if (!run) throw new Error("Creating a run returned no row.");
    const content: ModelMessage = {
      role: "user",
      content: renderBatch(await toEnvelopeItems(tx, userId, items), timeZone),
    };
    const [stored] = await tx
      .insert(runMessages)
      .values({ runId: run.id, seq: 0, role: "user", content })
      .returning({ id: runMessages.id });
    if (!stored) throw new Error("Storing the turn's input returned no row.");
    await tx
      .update(inboundItems)
      .set({ consumedByRunId: run.id })
      .where(
        inArray(
          inboundItems.id,
          items.map((item) => item.id),
        ),
      );
    return { runId: run.id, input: { id: stored.id, content } };
  });
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
