import type { DbOrTx } from "@winston/db/client";
import { frontState, modelCalls, runMessages, runs } from "@winston/db/schema";
import type { Logger } from "@winston/shared/logger";
import { asc, desc, eq, and, gte } from "drizzle-orm";

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

/**
 * Advances the user's window start when their conversation outgrows the
 * budget. The measure is the real input and output tokens of their latest
 * model call (exact and free). How much each message contributes is
 * estimated from its share of the text, scaled to that real total. Whole
 * turns (runs) drop from the front, so a cut never lands between a tool call
 * and its result, and the turn in progress always stays. Nothing is deleted.
 */
export async function trimWindow(
  db: DbOrTx,
  userId: string,
  systemPrompt: string,
  budget: WindowBudget,
  logger: Logger,
) {
  const [latest] = await db
    .select({ input: modelCalls.inputTokens, output: modelCalls.outputTokens })
    .from(modelCalls)
    .innerJoin(runs, eq(runs.id, modelCalls.runId))
    .where(eq(runs.userId, userId))
    .orderBy(desc(modelCalls.id))
    .limit(1);
  const tokens = latest ? latest.input + latest.output : 0;
  if (tokens <= budget.maxTokens) return;

  const [state] = await db
    .select({ start: frontState.windowStartMessageId })
    .from(frontState)
    .where(eq(frontState.userId, userId));
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
        eq(runs.status, "completed"),
        gte(runMessages.id, state?.start ?? 0),
      ),
    )
    .orderBy(asc(runMessages.id));

  // The stream as turns, oldest first, each with its first message id and size.
  const turns: { startId: number; chars: number }[] = [];
  let lastRunId: string | undefined;
  for (const row of rows) {
    const chars = JSON.stringify(row.content).length;
    const current = turns.at(-1);
    if (row.runId !== lastRunId || !current)
      turns.push({ startId: row.id, chars });
    else current.chars += chars;
    lastRunId = row.runId;
  }
  const totalChars =
    systemPrompt.length + turns.reduce((sum, turn) => sum + turn.chars, 0);
  const tokensPerChar = tokens / totalChars;

  let remaining = tokens;
  let keepFrom = 0;
  while (remaining > budget.targetTokens && keepFrom < turns.length - 1) {
    remaining -= (turns[keepFrom]?.chars ?? 0) * tokensPerChar;
    keepFrom += 1;
  }
  const newStart = turns[keepFrom]?.startId;
  if (keepFrom === 0 || newStart === undefined) return;

  await db
    .insert(frontState)
    .values({ userId, windowStartMessageId: newStart })
    .onConflictDoUpdate({
      target: frontState.userId,
      set: { windowStartMessageId: newStart },
    });
  logger.info(
    {
      tokens,
      estimatedAfter: Math.round(remaining),
      droppedTurns: keepFrom,
      windowStartMessageId: newStart,
    },
    "trimmed the front-of-house window",
  );
}
