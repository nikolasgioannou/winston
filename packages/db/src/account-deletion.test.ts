import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { requestAccountDeletion } from "./account-deletion.ts";
import { jobs, users, webSessions } from "./schema/index.ts";
import { inRollback, insertUser, testDb } from "./testing.ts";
import { createSession } from "./web-sessions.ts";

const db = await testDb();

describe("requestAccountDeletion", () => {
  test("marks the user, ends their sessions and queues one delete_user job that outlives them", async () => {
    await inRollback(db, async (tx) => {
      const user = await insertUser(tx);
      await createSession(tx, user.id);
      expect(await requestAccountDeletion(tx, user.id)).toBe(true);
      expect(await requestAccountDeletion(tx, user.id)).toBe(false);

      const [row] = await tx.select().from(users).where(eq(users.id, user.id));
      expect(row?.deletionRequestedAt).toBeInstanceOf(Date);
      expect(
        await tx
          .select()
          .from(webSessions)
          .where(eq(webSessions.userId, user.id)),
      ).toEqual([]);
      const queued = await tx
        .select({ userId: jobs.userId, payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.type, "delete_user"));
      expect(queued).toContainEqual({
        userId: null,
        payload: { userId: user.id },
      });
      expect(
        queued.filter(
          (job) => (job.payload as { userId: string }).userId === user.id,
        ),
      ).toHaveLength(1);
    });
  });
});
