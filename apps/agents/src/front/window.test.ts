import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { frontState, modelCalls, runMessages } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { ensurePromptVersion, promptVersion } from "@winston/prompts";
import { createLogger } from "@winston/shared/logger";
import type { ModelMessage } from "ai";
import { eq } from "drizzle-orm";
import { longOutputChars, shortened, trimWindow } from "./window.ts";

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
 * tool call and its result (`outputChars` long), and a reply. Returns each
 * turn's first message id.
 */
async function conversation(tx: DbOrTx, count: number, outputChars = 300) {
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
            output: { type: "text", value: "y".repeat(outputChars) },
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

/** Records the user's latest model call as having seen `tokens` of context, `minutesAgo`. */
async function lastCallSaw(
  tx: DbOrTx,
  userId: string,
  tokens: number,
  kind: "front" | "background" = "front",
  minutesAgo = 0,
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
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
}

async function windowStart(tx: DbOrTx, userId: string) {
  const [state] = await tx
    .select()
    .from(frontState)
    .where(eq(frontState.userId, userId));
  return state?.windowStartMessageId ?? 0;
}

async function stubBefore(tx: DbOrTx, userId: string) {
  const [state] = await tx
    .select()
    .from(frontState)
    .where(eq(frontState.userId, userId));
  return state?.stubBeforeMessageId ?? 0;
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

  test("a warm cache under budget leaves old tool output alone", async () => {
    await inRollback(db, async (tx) => {
      const { userId } = await conversation(tx, 4, 5_000);
      await lastCallSaw(tx, userId, 9_000, "front", 59);
      await trimWindow(tx, userId, system, budget, logger);
      expect(await stubBefore(tx, userId)).toBe(0);
    });
  });

  test("once the cache has expired, long tool output before the latest turn is shortened, and no turn drops", async () => {
    await inRollback(db, async (tx) => {
      const { userId, starts } = await conversation(tx, 4, 5_000);
      await lastCallSaw(tx, userId, 9_000, "front", 61);
      await trimWindow(tx, userId, system, budget, logger);
      expect(await stubBefore(tx, userId)).toBe(starts.at(-1) ?? -1);
      expect(await windowStart(tx, userId)).toBe(0);
    });
  });

  test("over budget, shortening old tool output comes first, and turns drop only if that isn't enough", async () => {
    await inRollback(db, async (tx) => {
      // Mostly tool output: shortening it alone gets under the target.
      const { userId, starts } = await conversation(tx, 10, 5_000);
      await lastCallSaw(tx, userId, 12_000);
      await trimWindow(tx, userId, system, budget, logger);
      expect(await stubBefore(tx, userId)).toBe(starts.at(-1) ?? -1);
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

describe("shortened", () => {
  const result = (value: string): ModelMessage => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "bash",
        output: { type: "text", value },
      },
    ],
  });
  const text = (message: ModelMessage) =>
    message.role === "tool" &&
    message.content[0]?.type === "tool-result" &&
    message.content[0].output.type === "text"
      ? message.content[0].output.value
      : undefined;

  test("long tool output keeps its start and says how to get the rest", () => {
    const value = `exit code 0\n--- stdout ---\n${"page text ".repeat(500)}`;
    const short = text(shortened(result(value))) ?? "";
    expect(short.startsWith(value.slice(0, 400))).toBe(true);
    expect(short).toContain(
      `[… ${String(value.length - 400)} more characters, no longer in the conversation; run it again if you need them.]`,
    );
    expect(short.length).toBeLessThan(600);
  });

  test("short output and other messages stay as they are", () => {
    const short = result("y".repeat(longOutputChars));
    expect(shortened(short)).toEqual(short);
    const reply: ModelMessage = {
      role: "assistant",
      content: "x".repeat(5_000),
    };
    expect(shortened(reply)).toEqual(reply);
  });
});
