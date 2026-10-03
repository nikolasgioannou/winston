import type { DbOrTx } from "@winston/db/client";
import { frontState, modelCalls, runMessages, runs } from "@winston/db/schema";
import type { Logger } from "@winston/shared/logger";
import type { ModelMessage } from "ai";
import { asc, desc, eq, and, gte } from "drizzle-orm";
import { cacheTtlMs } from "../model/cache.ts";
import { modelProfiles } from "../model/gateway.ts";

/** The rolling window's size, in tokens (docs/design.md §2, "Rolling window"). */
export interface WindowBudget {
  /** Trim when the latest context passes this. */
  maxTokens: number;
  /** Trim down to about this, so trims are rare and the cached prefix stays put between them. */
  targetTokens: number;
}

export const defaultWindowBudget: WindowBudget = {
  maxTokens: 150_000,
  targetTokens: 100_000,
};

/** Tool output longer than this is shortened once it's behind the stub boundary. */
export const longOutputChars = 1_500;
/** How much of a shortened output stays: its start, which says what it was. */
const keptOutputChars = 400;

/**
 * A stored message as the window shows it once it's behind the stub
 * boundary: long tool output (page text, mail bodies, listings) is cut to
 * its start and a note, so it stops riding along in every request. The
 * call stays, and running it again brings the output back.
 */
export function shortened(message: ModelMessage): ModelMessage {
  if (message.role !== "tool") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (
        part.type !== "tool-result" ||
        part.output.type !== "text" ||
        part.output.value.length <= longOutputChars
      )
        return part;
      const { value } = part.output;
      const dropped = value.length - keptOutputChars;
      return {
        ...part,
        output: {
          ...part.output,
          value: `${value.slice(0, keptOutputChars)}\n[… ${String(dropped)} more characters, no longer in the conversation; run it again if you need them.]`,
        },
      };
    }),
  };
}

/**
 * Keeps the user's window in budget, changing it only when that costs
 * nothing extra, since any change re-writes the cached prompt (§2):
 *
 * - When the cache has expired since their last call, long tool output in
 *   all but the latest turn is shortened (`shortened`); the boundary only
 *   moves forward.
 * - When the conversation outgrows the budget, that happens too, and whole
 *   turns (runs) drop from the front down to about the target, so a cut
 *   never lands between a tool call and its result, and the latest turn
 *   always stays.
 *
 * The measure is the real input and output tokens of their latest model
 * call (exact and free). How much each message contributes is estimated
 * from its share of the text, scaled to that real total. Nothing is deleted.
 */
export async function trimWindow(
  db: DbOrTx,
  userId: string,
  systemPrompt: string,
  budget: WindowBudget,
  logger: Logger,
) {
  const [latest] = await db
    .select({
      input: modelCalls.inputTokens,
      output: modelCalls.outputTokens,
      at: modelCalls.createdAt,
    })
    .from(modelCalls)
    .innerJoin(runs, eq(runs.id, modelCalls.runId))
    .where(and(eq(runs.userId, userId), eq(runs.kind, "front")))
    .orderBy(desc(modelCalls.id))
    .limit(1);
  const tokens = latest ? latest.input + latest.output : 0;
  const over = tokens > budget.maxTokens;
  const cold =
    !latest ||
    Date.now() - latest.at.getTime() > cacheTtlMs[modelProfiles.front.cacheTtl];
  if (!over && !cold) return;

  const [state] = await db
    .select({
      start: frontState.windowStartMessageId,
      stubBefore: frontState.stubBeforeMessageId,
    })
    .from(frontState)
    .where(eq(frontState.userId, userId));
  const oldStubBefore = state?.stubBefore ?? 0;
  const rows = await db
    .select({
      id: runMessages.id,
      runId: runMessages.runId,
      content: runMessages.content,
    })
    .from(runMessages)
    .innerJoin(runs, eq(runs.id, runMessages.runId))
    .where(
      and(
        eq(runs.userId, userId),
        eq(runs.kind, "front"),
        eq(runs.status, "completed"),
        gte(runMessages.id, state?.start ?? 0),
      ),
    )
    .orderBy(asc(runMessages.id));

  // The stream as turns, oldest first: each one's first message id, and its
  // size in full and with long tool output shortened.
  const turns: { startId: number; chars: number; shortChars: number }[] = [];
  let lastRunId: string | undefined;
  for (const row of rows) {
    const message = row.content as ModelMessage;
    const chars = JSON.stringify(message).length;
    const shortChars = JSON.stringify(shortened(message)).length;
    const current = turns.at(-1);
    if (row.runId !== lastRunId || !current)
      turns.push({ startId: row.id, chars, shortChars });
    else {
      current.chars += chars;
      current.shortChars += shortChars;
    }
    lastRunId = row.runId;
  }
  const latestTurn = turns.at(-1);
  if (!latestTurn) return;
  const stubBefore = Math.max(oldStubBefore, latestTurn.startId);
  const size = (boundary: number) =>
    systemPrompt.length +
    turns.reduce(
      (sum, turn) =>
        sum + (turn.startId < boundary ? turn.shortChars : turn.chars),
      0,
    );
  // Scaled to what the latest call actually measured, as it was sent then.
  const tokensPerChar = tokens / size(oldStubBefore);
  let remaining = size(stubBefore) * tokensPerChar;

  let keepFrom = 0;
  if (over)
    while (remaining > budget.targetTokens && keepFrom < turns.length - 1) {
      const turn = turns[keepFrom];
      if (turn)
        remaining -=
          (turn.startId < stubBefore ? turn.shortChars : turn.chars) *
          tokensPerChar;
      keepFrom += 1;
    }
  const windowStartMessageId =
    keepFrom > 0 ? (turns[keepFrom]?.startId ?? 0) : (state?.start ?? 0);
  if (
    windowStartMessageId === (state?.start ?? 0) &&
    stubBefore === oldStubBefore
  )
    return;

  await db
    .insert(frontState)
    .values({ userId, windowStartMessageId, stubBeforeMessageId: stubBefore })
    .onConflictDoUpdate({
      target: frontState.userId,
      set: { windowStartMessageId, stubBeforeMessageId: stubBefore },
    });
  logger.info(
    {
      tokens,
      cold,
      estimatedAfter: Math.round(remaining),
      droppedTurns: keepFrom,
      windowStartMessageId,
      stubBeforeMessageId: stubBefore,
    },
    keepFrom > 0
      ? "trimmed the front-of-house window"
      : "shortened old tool output in the front-of-house window",
  );
}
