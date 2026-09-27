import { describe, expect, test } from "bun:test";
import { eq, sql, sum } from "drizzle-orm";
import { inRollback, insertRun, insertUser, testDb } from "../testing.ts";
import { costLedger, modelCalls, promptVersions, runs } from "./index.ts";

const db = await testDb();

const call = (runId: string, promptHash: string) => ({
  runId,
  step: 0,
  model: "anthropic/claude-sonnet-5",
  provider: "anthropic",
  promptHash,
  contextFromMessageId: 1,
  contextToMessageId: 4,
  inputTokens: 1200,
  cachedTokens: 1000,
  cacheWriteTokens: 0,
  outputTokens: 80,
  reasoningTokens: 0,
  costUsd: "0.001234",
  latencyMs: 950,
  stopReason: "tool_use",
});

describe("model calls", () => {
  test("record a call against a stored prompt version", async () => {
    await inRollback(db, async (tx) => {
      const run = await insertRun(tx, (await insertUser(tx)).id);
      await tx
        .insert(promptVersions)
        .values({ hash: "abc", name: "front", content: "…" });
      await tx.insert(modelCalls).values(call(run.id, "abc"));

      const [stored] = await tx
        .select()
        .from(modelCalls)
        .where(eq(modelCalls.runId, run.id));
      expect(stored).toMatchObject({
        promptHash: "abc",
        cachedTokens: 1000,
        costUsd: "0.001234",
      });
    });
  });

  test("a call must reference a known prompt version", async () => {
    await inRollback(db, async (tx) => {
      const run = await insertRun(tx, (await insertUser(tx)).id);
      const insertWithUnknownPrompt = async () => {
        await tx.insert(modelCalls).values(call(run.id, "missing"));
      };
      const error = await insertWithUnknownPrompt().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("calls go with their run", async () => {
    await inRollback(db, async (tx) => {
      const run = await insertRun(tx, (await insertUser(tx)).id);
      await tx
        .insert(promptVersions)
        .values({ hash: "abc", name: "front", content: "…" });
      await tx.insert(modelCalls).values(call(run.id, "abc"));
      await tx.delete(runs).where(eq(runs.id, run.id));
      expect(await tx.select().from(modelCalls)).toEqual([]);
    });
  });
});

describe("cost ledger", () => {
  test("costs sum exactly, and charges outlive their run", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      await tx.insert(costLedger).values([
        {
          userId: user.id,
          runId: run.id,
          category: "model",
          costUsd: "0.100000",
        },
        {
          userId: user.id,
          runId: run.id,
          category: "model",
          costUsd: "0.200000",
        },
      ]);
      await tx.delete(runs).where(eq(runs.id, run.id));

      const [total] = await tx
        .select({ total: sum(costLedger.costUsd) })
        .from(costLedger)
        .where(eq(costLedger.userId, user.id));
      expect(total?.total).toBe("0.300000");
    });
  });

  test("the category must be a known one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const insertUnknown = async () => {
        await tx.execute(
          sql`insert into cost_ledger (user_id, category, cost_usd) values (${user.id}, 'lunch', 1)`,
        );
      };
      const error = await insertUnknown().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    });
  });
});
