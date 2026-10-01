import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { jobs } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { syncConnectionJob } from "@winston/domain/jobs";
import { eq, sql } from "drizzle-orm";
import {
  offsetOf,
  reconcileConnections,
  reconcileEveryMs,
} from "./reconcile.ts";

const db = await testDb();

const queued = (tx: DbOrTx, type: string) =>
  tx
    .select({
      payload: jobs.payload,
      dueInMs: sql<string>`extract(epoch from ${jobs.runAt} - now()) * 1000`,
    })
    .from(jobs)
    .where(eq(jobs.type, type));

describe("reconciliation", () => {
  test("every healthy connection gets a sync at its own offset; expired and disconnected ones don't", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const ok = await insertConnection(tx, user.id, {
        watchExpiresAt: new Date(Date.now() + 5 * 86_400_000),
      });
      const expiring = await insertConnection(tx, user.id, {
        status: "expiring",
        watchExpiresAt: new Date(Date.now() + 5 * 86_400_000),
      });
      await insertConnection(tx, user.id, { status: "expired" });
      await insertConnection(tx, user.id, { status: "disconnected" });
      expect(await reconcileConnections(tx)).toBe(2);
      const syncs = await queued(tx, "sync_connection");
      expect(
        syncs
          .map((j) => (j.payload as { connectionId: string }).connectionId)
          .sort(),
      ).toEqual([ok.id, expiring.id].sort());
      for (const job of syncs) {
        const id = (job.payload as { connectionId: string }).connectionId;
        expect(Math.abs(Number(job.dueInMs) - offsetOf(id))).toBeLessThan(
          5_000,
        );
      }
      expect(offsetOf(ok.id)).toBeLessThan(reconcileEveryMs);
      expect(offsetOf(ok.id)).toBe(offsetOf(ok.id));
    });
  });

  test("a push sync already queued isn't delayed; a push after a reconcile pulls it forward", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const first = await insertConnection(tx, user.id);
      const second = await insertConnection(tx, user.id);
      const push = (connectionId: string) =>
        enqueue(tx, syncConnectionJob.type, {
          userId: user.id,
          payload: { connectionId },
          dedupeKey: syncConnectionJob.dedupeKey(connectionId),
          onDuplicate: "reschedule",
        });
      await push(first.id);
      await reconcileConnections(tx);
      await push(second.id);
      const syncs = await queued(tx, "sync_connection");
      expect(syncs).toHaveLength(2);
      for (const job of syncs) expect(Number(job.dueInMs)).toBeLessThan(1_000);
    });
  });

  test("a connection whose watch is missing gets one", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      const unwatched = await insertConnection(tx, user.id, {
        domain: "calendar",
      });
      await reconcileConnections(tx);
      const watches = await queued(tx, "watch_connection");
      expect(watches.map((j) => j.payload)).toEqual([
        { connectionId: unwatched.id },
      ]);
    });
  });
});
