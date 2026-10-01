import type { DbOrTx } from "@winston/db/client";
import { tokenContext } from "@winston/db/connections";
import {
  connections,
  inboundItems,
  jobs,
  runMessages,
  runs,
  telegramLinks,
  users,
  vms,
} from "@winston/db/schema";
import { applyVmEvent } from "@winston/db/vm-state";
import type { TokenVault } from "@winston/shared/token-vault";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blobs.ts";
import type { RevokeGoogleToken } from "../connections/revoke.ts";
import type { TelegramSender } from "../telegram/sender.ts";
import type { VmProvider } from "../vm/provider.ts";
import type { JobHandler } from "../worker.ts";

export const goodbyeMessage =
  "Your Winston account has been deleted, along with everything in it. Goodbye, and thank you.";

export interface DeleteUserDeps {
  provider: VmProvider;
  vault: TokenVault;
  revoke: RevokeGoogleToken;
  blobs: BlobStore;
  telegram: Pick<TelegramSender, "sendMessage">;
}

/**
 * The `delete_user` job (docs/design.md §13, §17): wipes an account. Every
 * step checks what's left before acting, so a retry after a crash picks up
 * where the last attempt stopped:
 *
 * 1. Drop the user's queued jobs, so nothing (like a provisioning retry)
 *    brings anything back.
 * 2. Say goodbye in Telegram, briefly, then unlink the chat.
 * 3. Terminate the VM: the instance, then its data volume.
 * 4. Revoke every connected Google grant.
 * 5. Delete blobs only this user's rows refer to.
 * 6. Delete the user row, which cascades to every table with a `user_id`.
 *
 * The allowlist entry stays: whether they may come back is the founder's call.
 */
export function deleteUserHandler(deps: DeleteUserDeps): JobHandler {
  return async ({ job, db, logger }) => {
    const { userId } = z.object({ userId: z.string() }).parse(job.payload);
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) {
      logger.info({ userId }, "account already deleted");
      return;
    }

    await db
      .delete(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.status, "queued")));
    await sayGoodbye(db, deps, userId, logger);
    await terminateVm(db, deps.provider, userId);
    await revokeGrants(db, deps, userId);
    const blobKeys = await blobsOnlyTheyUse(db, userId);
    for (const key of blobKeys) await deps.blobs.delete(key);
    await db.delete(users).where(eq(users.id, userId));
    logger.info({ userId, blobs: blobKeys.length }, "account deleted");
  };
}

async function sayGoodbye(
  db: DbOrTx,
  { telegram }: DeleteUserDeps,
  userId: string,
  logger: Parameters<JobHandler>[0]["logger"],
) {
  const [link] = await db
    .select({ chatId: telegramLinks.chatId })
    .from(telegramLinks)
    .where(eq(telegramLinks.userId, userId));
  if (!link) return;
  // Best effort: a blocked bot or a network blip mustn't stop the deletion.
  await telegram
    .sendMessage(link.chatId, goodbyeMessage)
    .catch((error: unknown) => {
      logger.warn({ err: error, userId }, "couldn't say goodbye in Telegram");
    });
  await db.delete(telegramLinks).where(eq(telegramLinks.userId, userId));
}

async function terminateVm(db: DbOrTx, provider: VmProvider, userId: string) {
  const [vm] = await db.select().from(vms).where(eq(vms.userId, userId));
  if (!vm || vm.state === "terminated") return;
  if (vm.state !== "terminating") await applyVmEvent(db, vm.id, "terminate");
  if (vm.instanceId) await provider.destroy(vm.instanceId);
  if (vm.dataVolumeId)
    await provider.destroyDataVolume(vm.dataVolumeId, vm.userId);
  await applyVmEvent(db, vm.id, "terminated");
}

async function revokeGrants(
  db: DbOrTx,
  { vault, revoke }: DeleteUserDeps,
  userId: string,
) {
  const sealed = await db
    .select({ id: connections.id, token: connections.tokenCiphertext })
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        isNotNull(connections.tokenCiphertext),
      ),
    );
  for (const connection of sealed) {
    if (!connection.token) continue;
    // Revoking one grant revokes the account's others too; Google then calls
    // theirs invalid, which counts as revoked.
    await revoke(
      await vault.decrypt(connection.token, tokenContext(connection.id)),
    );
    await db
      .update(connections)
      .set({ tokenCiphertext: null })
      .where(eq(connections.id, connection.id));
  }
}

/**
 * The blobs this user's rows refer to that no one else's do. Blobs are
 * content-addressed, so two users who sent the same file share one.
 */
async function blobsOnlyTheyUse(db: DbOrTx, userId: string) {
  const mine = await referencedBlobs(db, userId, "theirs");
  if (mine.length === 0) return [];
  const others = new Set(await referencedBlobs(db, userId, "everyone else's"));
  return mine.filter((key) => !others.has(key));
}

/** Blob keys in a user's rows, or everyone else's: image stubs in run messages, and attachments' model copies. */
async function referencedBlobs(
  db: DbOrTx,
  userId: string,
  whose: "theirs" | "everyone else's",
) {
  const theirs = whose === "theirs";
  const fromMessages = await db
    .selectDistinct({
      key: sql<string>`(regexp_matches(${runMessages.content}::text, 'stored as blob ([0-9a-f]{64})', 'g'))[1]`,
    })
    .from(runMessages)
    .innerJoin(runs, eq(runs.id, runMessages.runId))
    .where(theirs ? eq(runs.userId, userId) : ne(runs.userId, userId));
  const fromAttachments = await db
    .selectDistinct({
      key: sql<
        string | null
      >`${inboundItems.payload} -> 'attachment' -> 'shown' ->> 'blobKey'`,
    })
    .from(inboundItems)
    .where(
      theirs
        ? eq(inboundItems.userId, userId)
        : ne(inboundItems.userId, userId),
    );
  return [...fromMessages, ...fromAttachments].flatMap((row) =>
    row.key ? [row.key] : [],
  );
}
