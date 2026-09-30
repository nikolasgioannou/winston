import { deleteUserJob } from "@winston/domain/jobs";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "./client.ts";
import { enqueue } from "./queue.ts";
import { users, webSessions } from "./schema/index.ts";

/**
 * Starts deleting a user's account (docs/design.md §13): marks it, so it
 * can't be signed in to, ends every session, and queues `delete_user`, which
 * removes everything. Returns false if deletion had already started.
 */
export async function requestAccountDeletion(db: DbOrTx, userId: string) {
  return db.transaction(async (tx) => {
    const [marked] = await tx
      .update(users)
      .set({ deletionRequestedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
      .returning({ id: users.id });
    if (!marked) return false;
    await tx.delete(webSessions).where(eq(webSessions.userId, userId));
    await enqueue(tx, deleteUserJob.type, {
      payload: { userId },
      dedupeKey: deleteUserJob.dedupeKey(userId),
    });
    return true;
  });
}
