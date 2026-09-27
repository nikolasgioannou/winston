import { describe, expect, test } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { inRollback, insertRun, insertUser, testDb } from "../testing.ts";
import { inboundItems, runMessages, runs } from "./index.ts";

const db = await testDb();

const message = (runId: string, seq: number, text: string) => ({
  runId,
  seq,
  role: "user",
  content: { role: "user", content: text },
});

describe("runs and run messages", () => {
  test("a run's messages read back in order", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      expect(run.id).toStartWith("run_");
      expect(run.status).toBe("running");

      await tx
        .insert(runMessages)
        .values([message(run.id, 0, "a"), message(run.id, 1, "b")]);
      const rows = await tx
        .select({ seq: runMessages.seq, content: runMessages.content })
        .from(runMessages)
        .where(eq(runMessages.runId, run.id))
        .orderBy(asc(runMessages.id));
      expect(rows).toEqual([
        { seq: 0, content: { role: "user", content: "a" } },
        { seq: 1, content: { role: "user", content: "b" } },
      ]);
    });
  });

  test("messages across a user's runs form one stream in id order", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const first = await insertRun(tx, user.id);
      const second = await insertRun(tx, user.id);
      await tx.insert(runMessages).values(message(first.id, 0, "turn 1"));
      await tx.insert(runMessages).values(message(second.id, 0, "turn 2"));

      const stream = await tx
        .select({ runId: runMessages.runId })
        .from(runMessages)
        .innerJoin(runs, eq(runs.id, runMessages.runId))
        .where(eq(runs.userId, user.id))
        .orderBy(asc(runMessages.id));
      expect(stream.map((row) => row.runId)).toEqual([first.id, second.id]);
    });
  });

  test("a run can't have two messages at the same position", async () => {
    await inRollback(db, async (tx) => {
      const run = await insertRun(tx, (await insertUser(tx)).id);
      await tx.insert(runMessages).values(message(run.id, 0, "a"));
      const insertDuplicate = async () => {
        await tx.insert(runMessages).values(message(run.id, 0, "b"));
      };
      const error = await insertDuplicate().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    });
  });

  test("run status only accepts known states", async () => {
    await inRollback(db, async (tx) => {
      const run = await insertRun(tx, (await insertUser(tx)).id);
      const setUnknown = async () => {
        await tx.execute(
          sql`update runs set status = 'exploded' where id = ${run.id}`,
        );
      };
      const error = await setUnknown().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
    });
  });
});

describe("inbound items", () => {
  const item = (userId: string, sourceRef: string) => ({
    userId,
    type: "user_message",
    payload: { text: "hi" },
    sourceRef,
    occurredAt: new Date(),
  });

  test("the same source can't be stored twice", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const [stored] = await tx
        .insert(inboundItems)
        .values(item(user.id, "telegram:1"))
        .returning();
      expect(stored?.id).toStartWith("hist_");
      const redelivered = await tx
        .insert(inboundItems)
        .values(item(user.id, "telegram:1"))
        .onConflictDoNothing()
        .returning();
      expect(redelivered).toEqual([]);
    });
  });

  test("deleting the handling run leaves the item, unconsumed", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const run = await insertRun(tx, user.id);
      const [stored] = await tx
        .insert(inboundItems)
        .values({ ...item(user.id, "telegram:2"), consumedByRunId: run.id })
        .returning();
      await tx.delete(runs).where(eq(runs.id, run.id));
      const [after] = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.id, stored?.id ?? ""));
      expect(after?.consumedByRunId).toBeNull();
    });
  });
});
