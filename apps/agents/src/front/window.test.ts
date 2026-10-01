import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { frontState, modelCalls, runMessages } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { ensurePromptVersion, promptVersion } from "@winston/prompts";
import { createLogger } from "@winston/shared/logger";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { trimWindow } from "./window.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const system = "s".repeat(400);
const prompt = promptVersion("front-of-house", [
  { name: "test", description: "window tests", inputSchema: {} },
]);

/**
 * A user with `count` turns of about the same size, each a user message, a
 * tool call and its result, and a reply. Returns each turn's first message id.
 */
async function conversation(tx: DbOrTx, count: number) {
  const user = await insertUser(tx);
  const starts: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // Only completed turns are part of the window.
    const run = await insertRun(tx, user.id, { status: "completed" });
    const messages: ModelMessage[] = [
      { role: "user", content: `turn ${String(i)} ${"x".repeat(300)}` },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: `c${String(i)}`,
            toolName: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `c${String(i)}`,
            toolName: "lookup",
            output: { type: "text", value: "y".repeat(300) },
          },
        ],
      },
      { role: "assistant", content: "z".repeat(300) },
    ];
    for (const [seq, message] of messages.entries()) {
      const [row] = await tx
        .insert(runMessages)
        .values({ runId: run.id, seq, role: message.role, content: message })
        .returning({ id: runMessages.id });
      if (seq === 0 && row) starts.push(row.id);
    }
  }
  return { userId: user.id, starts };
}

/** Records the user's latest model call as having seen `tokens` of context. */
async function lastCallSaw(
  tx: DbOrTx,
  userId: string,
  tokens: number,
  kind: "front" | "background" = "front",
) {
  const run = await insertRun(tx, userId, { kind });
  await ensurePromptVersion(tx, prompt);
  await tx.insert(modelCalls).values({
    runId: run.id,
    step: 0,
    model: "m",
    provider: "Anthropic",
    promptHash: prompt.hash,
    contextFromMessageId: 0,
    contextToMessageId: 0,
    inputTokens: tokens,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: "0",
    latencyMs: 1,
    stopReason: "stop",
  });
}

async function windowStart(tx: DbOrTx, userId: string) {
  const [state] = await tx
    .select()
    .from(frontState)
    .where(eq(frontState.userId, userId));
  return state?.windowStartMessageId ?? 0;
}

describe("trimWindow", () => {
  const budget = { maxTokens: 10_000, targetTokens: 6_000 };

  test("a window under budget is untouched", async () => {
    await inRollback(db, async (tx) => {
      const { userId } = await conversation(tx, 10);
      await lastCallSaw(tx, userId, 9_000);
      await trimWindow(tx, userId, system, budget, logger);
      expect(await windowStart(tx, userId)).toBe(0);
    });
  });

  test("over budget, whole turns drop from the front down to about the target", async () => {
    await inRollback(db, async (tx) => {
      const { userId, starts } = await conversation(tx, 10);
      await lastCallSaw(tx, userId, 12_000);
      await trimWindow(tx, userId, system, budget, logger);
      const start = await windowStart(tx, userId);
      // Lands exactly on a turn's first message: never between a tool call and its result.
      expect(starts).toContain(start);
      // About half the turns go (12k down to at most 6k), not just one.
      const kept = starts.filter((id) => id >= start).length;
      expect(kept).toBeGreaterThanOrEqual(4);
      expect(kept).toBeLessThanOrEqual(5);
    });
  });

  test("trims in chunks: the next turn's slightly bigger context doesn't trim again", async () => {
    await inRollback(db, async (tx) => {
      const { userId } = await conversation(tx, 10);
      await lastCallSaw(tx, userId, 12_000);
      await trimWindow(tx, userId, system, budget, logger);
      const first = await windowStart(tx, userId);
      await lastCallSaw(tx, userId, 6_500);
      await trimWindow(tx, userId, system, budget, logger);
      expect(await windowStart(tx, userId)).toBe(first);
    });
  });

  test("a background run's big context doesn't count against the front's window", async () => {
    await inRollback(db, async (tx) => {
      const { userId } = await conversation(tx, 10);
      await lastCallSaw(tx, userId, 9_000);
      await lastCallSaw(tx, userId, 500_000, "background");
      await trimWindow(tx, userId, system, budget, logger);
      expect(await windowStart(tx, userId)).toBe(0);
    });
  });

  test("always keeps the latest turn, however big", async () => {
    await inRollback(db, async (tx) => {
      const { userId, starts } = await conversation(tx, 3);
      await lastCallSaw(tx, userId, 1_000_000);
      await trimWindow(tx, userId, system, budget, logger);
      // The model-call run added by lastCallSaw has no messages, so the last conversation turn stays.
      expect(await windowStart(tx, userId)).toBe(starts.at(-1) ?? -1);
    });
  });
});
