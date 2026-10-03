import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { costLedger, modelCalls } from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { dbModelCallSink } from "./log.ts";
import { fakeCompletion, fakeGateway, testRun } from "./testing.ts";

const db = await testDb();

function capturingLogger() {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger("agents-test", {
    pretty: false,
    destination: {
      write: (line: string) =>
        logs.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  return { logger, logs };
}

async function runFor(tx: DbOrTx) {
  const user = await insertUser(tx);
  const run = await insertRun(tx, user.id);
  return testRun({
    runId: run.id,
    userId: user.id,
    contextRange: () => ({
      fromMessageId: 3,
      toMessageId: 7,
      stubBeforeMessageId: 5,
    }),
  });
}

describe("dbModelCallSink", () => {
  test("a gateway call writes exactly one model call and one ledger row", async () => {
    await inRollback(db, async (tx) => {
      const { logger } = capturingLogger();
      const run = await runFor(tx);
      const { gateway } = fakeGateway({ sink: dbModelCallSink(tx, logger) });
      await gateway.generate({ profile: "front", run, prompt: "hi" });

      const calls = await tx
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.runId, run.runId));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        step: 0,
        model: "anthropic/claude-sonnet-5",
        provider: "Anthropic",
        promptHash: run.prompt.hash,
        contextFromMessageId: 3,
        contextToMessageId: 7,
        contextStubBeforeMessageId: 5,
        inputTokens: 1200,
        cachedTokens: 1000,
        cacheWriteTokens: 150,
        outputTokens: 40,
        reasoningTokens: 12,
        costUsd: "0.001230",
        stopReason: "stop",
      });
      const ledger = await tx
        .select()
        .from(costLedger)
        .where(eq(costLedger.runId, run.runId));
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        userId: run.userId,
        category: "model",
        costUsd: "0.001230",
      });
    });
  });

  test("falls back to the price table when OpenRouter reports no cost", async () => {
    await inRollback(db, async (tx) => {
      const { logger } = capturingLogger();
      const run = await runFor(tx);
      const usage: Record<string, unknown> = { ...fakeCompletion.usage };
      delete usage.cost;
      const { gateway } = fakeGateway({
        replies: [{ usage }],
        sink: dbModelCallSink(tx, logger),
      });
      await gateway.generate({ profile: "front", run, prompt: "hi" });
      const [call] = await tx
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.runId, run.runId));
      // 50 uncached × $2 + 1000 cached × $0.20 + 150 written × $2.50 + 40 out × $10, per million.
      // The front of house caches for an hour, so its writes cost $4/M, not $2.50/M.
      expect(call?.costUsd).toBe("0.001300");
    });
  });

  test("warns when the reported cost drifts from the price table or the provider isn't Anthropic", async () => {
    await inRollback(db, async (tx) => {
      const { logger, logs } = capturingLogger();
      const run = await runFor(tx);
      const { gateway } = fakeGateway({
        replies: [
          {
            provider: "Amazon Bedrock",
            usage: { ...fakeCompletion.usage, cost: 0.01 },
          },
        ],
        sink: dbModelCallSink(tx, logger),
      });
      await gateway.generate({ profile: "front", run, prompt: "hi" });
      const warnings = logs
        .filter((line) => line.level === 40)
        .map((line) => line.msg);
      expect(warnings).toContain(
        "model call not served by Anthropic despite pinning",
      );
      expect(warnings).toContain(
        "reported cost differs from the price table; update pricing.ts",
      );
    });
  });

  test("a database failure is logged with the record and doesn't fail the call", async () => {
    const { logger, logs } = capturingLogger();
    const brokenDb = {
      insert: () => {
        throw new Error("database is down");
      },
    } as unknown as DbOrTx;
    const { gateway } = fakeGateway({
      sink: dbModelCallSink(brokenDb, logger),
    });
    const result = await gateway.generate({
      profile: "front",
      run: testRun(),
      prompt: "hi",
    });
    expect(result.text).toBe("Done.");
    const failure = logs.find(
      (line) => line.msg === "recording a model call failed",
    );
    expect(failure).toMatchObject({
      runId: "run_test",
      record: { inputTokens: 1200 },
    });
  });
});
