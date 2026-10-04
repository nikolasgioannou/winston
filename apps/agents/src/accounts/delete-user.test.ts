import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DbOrTx } from "@winston/db/client";
import { saveConnection } from "@winston/db/connections";
import { checkMailboxName, turnOnMailbox } from "@winston/db/mailbox";
import type { Job } from "@winston/db/queue";
import * as schema from "@winston/db/schema";
import {
  allowedEmails,
  frontState,
  inboundItems,
  outboundMessages,
  runMessages,
  runs,
  telegramLinks,
  users,
  vms,
} from "@winston/db/schema";
import { issueLinkToken } from "@winston/db/telegram-link-tokens";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { applyVmEvent } from "@winston/db/vm-state";
import { requestVm } from "@winston/db/vms";
import { createSession } from "@winston/db/web-sessions";
import { createLogger } from "@winston/shared/logger";
import { localTokenVault } from "@winston/shared/token-vault";
import { count, eq, getColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { localBlobStore } from "@winston/blobs";
import type { VmProvider } from "../vm/provider.ts";
import { deleteUserHandler, goodbyeMessage } from "./delete-user.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const vault = localTokenVault("34".repeat(32));

/** Every table in the schema with a `user_id` column, with that column. */
const userTables = Object.values(schema).flatMap((value) => {
  if (!is(value, PgTable)) return [];
  const userId = (getColumns(value) as Record<string, PgColumn | undefined>)
    .userId;
  return userId ? [{ table: value, userId }] : [];
});

/** A user with something in as many tables as practical, and a VM that exists. */
async function fullAccount(tx: DbOrTx, blobKey: string) {
  const user = await insertUser(tx);
  await tx.insert(allowedEmails).values({ email: user.email });
  await requestVm(tx, user.id);
  const [vm] = await tx.select().from(vms).where(eq(vms.userId, user.id));
  if (!vm) throw new Error("expected a VM");
  await applyVmEvent(tx, vm.id, "provision");
  await tx
    .update(vms)
    .set({ instanceId: "inst-1", dataVolumeId: "vol-1" })
    .where(eq(vms.id, vm.id));
  await tx
    .insert(telegramLinks)
    .values({ userId: user.id, chatId: 9001, telegramUserId: 9001 });
  await issueLinkToken(tx, user.id);
  await createSession(tx, user.id);
  await saveConnection(tx, vault, {
    userId: user.id,
    domain: "mail",
    provider: "gmail",
    externalEmail: "ada@acme.com",
    scopes: ["gmail.modify"],
    refreshToken: "refresh-mail",
  });
  await turnOnMailbox(tx, user.id, "ada-winston");
  await tx.insert(inboundItems).values({
    userId: user.id,
    type: "user_message",
    payload: {
      text: "",
      telegramMessageId: 1,
      attachment: { shown: { blobKey } },
    },
    occurredAt: new Date(),
  });
  const [run] = await tx.insert(runs).values({ userId: user.id }).returning();
  if (!run) throw new Error("expected a run");
  await tx.insert(runMessages).values({
    runId: run.id,
    seq: 0,
    role: "tool",
    content: [{ type: "text", text: `[image, stored as blob ${blobKey}]` }],
  });
  await tx
    .insert(outboundMessages)
    .values({ userId: user.id, runId: run.id, text: "hi" });
  await tx.insert(frontState).values({ userId: user.id });
  return { user, vm };
}

function fakes() {
  const calls: string[] = [];
  const provider = {
    destroy: (id: string) => {
      calls.push(`destroy ${id}`);
      return Promise.resolve();
    },
    destroyDataVolume: (id: string) => {
      calls.push(`volume ${id}`);
      return Promise.resolve();
    },
  } as unknown as VmProvider;
  const revoked: string[] = [];
  const sent: { chatId: number; text: string }[] = [];
  return {
    calls,
    revoked,
    sent,
    deps: {
      provider,
      vault,
      revoke: (token: string) => {
        revoked.push(token);
        return Promise.resolve();
      },
      telegram: {
        sendMessage: (chatId: number, text: string) => {
          sent.push({ chatId, text });
          return Promise.resolve({ message_id: 1 });
        },
      },
    },
  };
}

const run = (
  tx: DbOrTx,
  deps: Parameters<typeof deleteUserHandler>[0],
  userId: string,
) =>
  deleteUserHandler(deps)({
    job: { id: "job_1", payload: { userId } } as unknown as Job,
    db: tx as never,
    logger,
    extendLease: () => Promise.resolve(true),
  });

describe("deleteUserHandler", () => {
  test("every user_id column cascades from users, so a new table can't forget to join the deletion", async () => {
    const loose = await db.execute<{ table_name: string }>(sql`
      select c.table_name from information_schema.columns c
      where c.table_schema = 'public' and c.column_name = 'user_id'
      except
      select k.table_name from information_schema.key_column_usage k
      join information_schema.referential_constraints r
        on r.constraint_name = k.constraint_name
      where k.column_name = 'user_id' and r.delete_rule = 'CASCADE'
    `);
    expect([...loose]).toEqual([]);
    expect(userTables.length).toBeGreaterThan(10);
  });

  test("says goodbye, destroys the VM and its volume, revokes grants, deletes their blobs and leaves no rows", async () => {
    await inRollback(db, async (tx) => {
      const blobs = localBlobStore(await mkdtemp(`${tmpdir()}/winston-blobs-`));
      const key = await blobs.put(new TextEncoder().encode("only theirs"));
      const { user } = await fullAccount(tx, key);
      const { deps, calls, revoked, sent } = fakes();

      await run(tx, { ...deps, blobs }, user.id);

      expect(sent).toEqual([{ chatId: 9001, text: goodbyeMessage }]);
      expect(calls).toEqual(["destroy inst-1", "volume vol-1"]);
      expect(revoked).toEqual(["refresh-mail"]);
      expect(await blobs.get(key).catch(() => "gone")).toBe("gone");
      for (const { table, userId } of userTables) {
        const [rows] = await tx
          .select({ n: count() })
          .from(table)
          .where(eq(userId, user.id));
        expect({ table: getTableName(table), n: rows?.n }).toEqual({
          table: getTableName(table),
          n: 0,
        });
      }
      // Winston's address is gone, but nobody else can ever have it.
      expect(await checkMailboxName(tx, "ada-winston")).toEqual({
        ok: false,
        problem: "taken",
      });
      // Whether they may come back is the founder's call.
      expect(
        await tx
          .select()
          .from(allowedEmails)
          .where(eq(allowedEmails.email, user.email)),
      ).toHaveLength(1);
    });
  });

  test("keeps a blob another user also refers to", async () => {
    await inRollback(db, async (tx) => {
      const blobs = localBlobStore(await mkdtemp(`${tmpdir()}/winston-blobs-`));
      const shared = await blobs.put(new TextEncoder().encode("the same file"));
      const { user } = await fullAccount(tx, shared);
      const other = await insertUser(tx);
      await tx.insert(inboundItems).values({
        userId: other.id,
        type: "user_message",
        payload: {
          text: "",
          telegramMessageId: 2,
          attachment: { shown: { blobKey: shared } },
        },
        occurredAt: new Date(),
      });
      await run(tx, { ...fakes().deps, blobs }, user.id);
      expect(await blobs.get(shared)).toEqual(
        new TextEncoder().encode("the same file"),
      );
    });
  });

  test("a retry after a failure part-way finishes the job, and running it again is a no-op", async () => {
    await inRollback(db, async (tx) => {
      const blobs = localBlobStore(await mkdtemp(`${tmpdir()}/winston-blobs-`));
      const { user } = await fullAccount(tx, "a".repeat(64));
      const { deps, calls, sent } = fakes();

      const failing = await run(
        tx,
        {
          ...deps,
          blobs,
          revoke: () => Promise.reject(new Error("Google is down")),
        },
        user.id,
      ).catch((e: unknown) => e);
      expect(failing).toBeInstanceOf(Error);
      expect(
        await tx.select().from(users).where(eq(users.id, user.id)),
      ).toHaveLength(1);

      await run(tx, { ...deps, blobs }, user.id);
      await run(tx, { ...deps, blobs }, user.id);
      expect(
        await tx.select().from(users).where(eq(users.id, user.id)),
      ).toEqual([]);
      // Already-done steps weren't repeated: one goodbye, one VM teardown.
      expect(sent).toHaveLength(1);
      expect(calls).toEqual(["destroy inst-1", "volume vol-1"]);
      expect(
        await tx
          .select()
          .from(inboundItems)
          .where(eq(inboundItems.userId, user.id)),
      ).toEqual([]);
    });
  });
});
