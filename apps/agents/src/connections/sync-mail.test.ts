import { describe, expect, test } from "bun:test";
import {
  HistoryExpiredError,
  type HistoryMessage,
  type HistoryRecord,
} from "@winston/connectors/gmail-sync";
import type { FullMailMessage, MailProvider } from "@winston/connectors/mail";
import type { DbOrTx } from "@winston/db/client";
import { auditLog, connections, events } from "@winston/db/schema";
import {
  inRollback,
  insertConnection,
  insertUser,
  testDb,
} from "@winston/db/testing";
import { asc, eq } from "drizzle-orm";
import { refFor } from "@winston/db/external-refs";
import { syncMail, type MailSyncDeps } from "./sync-mail.ts";

const db = await testDb();
const me = "me@example.com";

const message = (
  id: string,
  overrides: Partial<FullMailMessage> = {},
): FullMailMessage => ({
  providerId: id,
  threadId: "t1",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [{ name: null, email: me }],
  cc: [],
  subject: "Re: Lease",
  date: new Date("2026-10-01T14:00:00Z"),
  snippet: "Tuesday works",
  unread: true,
  starred: false,
  inInbox: true,
  labels: [],
  attachments: [],
  messageIdHeader: null,
  body: "Tuesday works.",
  references: [],
  replyTo: [],
  quotedTextHidden: false,
  ...overrides,
});

/** A Gmail standing in: history records, threads by id, and the mailbox's history id. */
function gmail(options: {
  records?: HistoryRecord[];
  expired?: boolean;
  recent?: HistoryMessage[];
  threads?: Record<string, FullMailMessage[]>;
  labels?: Record<string, string>;
  failThread?: boolean;
}): MailSyncDeps {
  return {
    sync: {
      history: (start: string) =>
        options.expired
          ? Promise.reject(new HistoryExpiredError(start))
          : Promise.resolve({
              records: options.records ?? [],
              historyId: "900",
            }),
      currentHistoryId: () => Promise.resolve("950"),
      recentMessages: () => Promise.resolve(options.recent ?? []),
      labelNames: () =>
        Promise.resolve(new Map(Object.entries(options.labels ?? {}))),
      watch: () => Promise.reject(new Error("unused")),
      stop: () => Promise.resolve(),
    },
    mail: {
      getThread: (id: string) =>
        options.failThread
          ? Promise.reject(new Error("Gmail is down"))
          : Promise.resolve({
              providerId: id,
              subject: "Re: Lease",
              messages: options.threads?.[id] ?? [],
            }),
    } as unknown as MailProvider,
  };
}

async function connection(tx: DbOrTx, historyId: string | null = "100") {
  const user = await insertUser(tx);
  return insertConnection(tx, user.id, {
    externalEmail: me,
    ...(historyId ? { syncState: { historyId } } : {}),
  });
}

const stored = (tx: DbOrTx) =>
  tx.select().from(events).orderBy(asc(events.dedupeKey));
const checkpointOf = async (tx: DbOrTx, id: string) =>
  (
    (await tx.select().from(connections).where(eq(connections.id, id)))[0]
      ?.syncState as { historyId?: string } | null
  )?.historyId;

const added = (
  id: string,
  labelIds: string[],
  threadId = "t1",
): HistoryRecord => ({
  id: `h-${id}`,
  messagesAdded: [{ message: { id, threadId, labelIds } }],
});

describe("mail sync", () => {
  test("the first sync only takes its place in history", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx, null);
      expect(
        await syncMail(tx, conn, gmail({ records: [added("m1", ["INBOX"])] })),
      ).toEqual([]);
      expect(await checkpointOf(tx, conn.id)).toBe("950");
    });
  });

  test("a new inbox message is received, a reply to the user when they sent the one before; drafts are skipped", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      const deps = gmail({
        records: [
          added("m2", ["INBOX", "UNREAD", "CATEGORY_PERSONAL"]),
          added("d1", ["DRAFT"]),
        ],
        threads: {
          t1: [
            message("m1", { from: { name: null, email: "Me@Example.com" } }),
            message("m2", {
              attachments: [
                {
                  providerId: "m2/1",
                  filename: "lease.pdf",
                  mimeType: "application/pdf",
                  size: 1,
                },
              ],
            }),
          ],
        },
      });
      const result = await syncMail(tx, conn, deps);
      expect(result.map((e) => e.type)).toEqual(["mail.message.received"]);
      expect(result[0]?.payload).toMatchObject({
        account: me,
        subject: "Re: Lease",
        category: "primary",
        unread: true,
        hasAttachments: true,
        isReplyToUser: true,
      });
      expect(
        (result[0]?.payload as { messageId: string }).messageId,
      ).toStartWith("msg_");
      expect(await checkpointOf(tx, conn.id)).toBe("900");
    });
  });

  test("a message the user sent is sent, and self-caused when Winston sent it", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      await tx.insert(auditLog).values({
        userId: conn.userId,
        connectionId: conn.id,
        action: "mail.reply",
        summary: "Replied to Dana",
        request: {},
        outcome: "ok",
        resultRef: "s1",
      });
      const deps = gmail({
        records: [added("s1", ["SENT"]), added("s2", ["SENT"], "t2")],
        threads: {
          t1: [message("s1", { from: { name: null, email: me } })],
          t2: [
            message("s2", { threadId: "t2", from: { name: null, email: me } }),
          ],
        },
      });
      const result = await syncMail(tx, conn, deps);
      expect(result.map((e) => [e.type, e.selfCaused])).toEqual([
        ["mail.message.sent", true],
        ["mail.message.sent", false],
      ]);
    });
  });

  test("label changes are named (the rest ignored), and self-caused when Winston just changed them", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      // Winston archived m5's thread a moment ago.
      const thread = await refFor(tx, conn.userId, conn.id, "thread", "t5");
      await tx.insert(auditLog).values({
        userId: conn.userId,
        connectionId: conn.id,
        action: "mail.update",
        summary: "Archived",
        request: { ids: [thread], archived: true },
        outcome: "ok",
      });
      const result = await syncMail(
        tx,
        conn,
        gmail({
          records: [
            {
              id: "h9",
              labelsAdded: [
                {
                  message: { id: "m5", threadId: "t5" },
                  labelIds: ["Label_7", "IMPORTANT"],
                },
              ],
              labelsRemoved: [
                {
                  message: { id: "m5", threadId: "t5" },
                  labelIds: ["UNREAD", "INBOX"],
                },
              ],
            },
            {
              id: "h10",
              labelsAdded: [
                {
                  message: { id: "m6", threadId: "t6" },
                  labelIds: ["Label_7"],
                },
              ],
            },
            {
              id: "h11",
              labelsAdded: [
                {
                  message: { id: "m7", threadId: "t7" },
                  labelIds: ["CATEGORY_UPDATES"],
                },
              ],
            },
          ],
          labels: { Label_7: "Lease" },
        }),
      );
      const rows = result
        .map((e) =>
          JSON.stringify([
            (e.payload as { added: string[] }).added,
            (e.payload as { removed: string[] }).removed,
            e.selfCaused,
          ]),
        )
        .sort();
      expect(rows).toEqual(
        [
          [[], ["unread", "inbox"], true],
          [["Lease"], [], false],
          [["Lease"], [], true],
        ]
          .map((row) => JSON.stringify(row))
          .sort(),
      );
    });
  });

  test("re-running the same history stores nothing new", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      const deps = gmail({
        records: [added("m2", ["INBOX"])],
        threads: { t1: [message("m2")] },
      });
      expect(await syncMail(tx, conn, deps)).toHaveLength(1);
      await tx
        .update(connections)
        .set({ syncState: { historyId: "100" } })
        .where(eq(connections.id, conn.id));
      expect(await syncMail(tx, conn, deps)).toHaveLength(0);
      expect(await stored(tx)).toHaveLength(1);
    });
  });

  test("expired history falls back to the last day's messages and starts over from now", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      const deps = gmail({
        expired: true,
        recent: [{ id: "m3", threadId: "t3", labelIds: ["INBOX"] }],
        threads: { t3: [message("m3", { threadId: "t3" })] },
      });
      const result = await syncMail(tx, conn, deps);
      expect(result.map((e) => e.type)).toEqual(["mail.message.received"]);
      expect(await checkpointOf(tx, conn.id)).toBe("950");
    });
  });

  test("a failure stores nothing and leaves the checkpoint where it was", async () => {
    await inRollback(db, async (tx) => {
      const conn = await connection(tx);
      const deps = gmail({
        records: [added("m2", ["INBOX"])],
        failThread: true,
      });
      const error: unknown = await syncMail(tx, conn, deps).catch(
        (reason: unknown) => reason,
      );
      expect((error as Error).message).toBe("Gmail is down");
      expect(await stored(tx)).toHaveLength(0);
      expect(await checkpointOf(tx, conn.id)).toBe("100");
    });
  });
});
