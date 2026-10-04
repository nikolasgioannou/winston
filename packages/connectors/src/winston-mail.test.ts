import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import { turnOnMailbox } from "@winston/db/mailbox";
import {
  connections,
  mailboxMessages,
  mailboxThreads,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { eq } from "drizzle-orm";
import { NotSupportedError, ProviderNotFoundError } from "./errors.ts";
import { winstonMailProvider } from "./winston-mail.ts";

const db = await testDb();

/** Synthetic raw mail with one attachment, written by hand. */
const raw = new TextEncoder().encode(
  [
    "From: dana@acme.example",
    "To: ada@runwinston.email",
    "Subject: Menu",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain",
    "",
    "Attached.",
    "--b",
    'Content-Type: text/csv; name="menu.csv"',
    'Content-Disposition: attachment; filename="menu.csv"',
    "",
    "dish,price",
    "--b--",
    "",
  ].join("\r\n"),
);

async function mailbox(tx: DbOrTx) {
  const user = await insertUser(tx);
  await turnOnMailbox(tx, user.id, "ada");
  const [connection] = await tx
    .select()
    .from(connections)
    .where(eq(connections.userId, user.id));
  if (!connection) throw new Error("expected the mailbox");
  const [thread] = await tx
    .insert(mailboxThreads)
    .values({
      userId: user.id,
      connectionId: connection.id,
      subject: "Lunch",
      lastMessageAt: new Date("2026-10-03T12:00:00Z"),
    })
    .returning();
  const message = async (
    fields: Partial<typeof mailboxMessages.$inferInsert>,
  ) => {
    const [row] = await tx
      .insert(mailboxMessages)
      .values({
        userId: user.id,
        connectionId: connection.id,
        threadId: thread?.id ?? "",
        direction: "received",
        subject: "Lunch",
        from: { name: "Dana Scully", email: "dana@acme.example" },
        to: [{ name: null, email: "ada@runwinston.email" }],
        date: new Date("2026-10-01T12:00:00Z"),
        body: "Friday?",
        snippet: "Friday?",
        labels: ["inbox", "unread"],
        rawBlobKey: "a".repeat(64),
        size: raw.byteLength,
        ...fields,
      })
      .returning();
    if (!row) throw new Error("expected the message");
    return row;
  };
  const provider = winstonMailProvider({
    db: tx,
    connection,
    rawMessage: (key) =>
      key === "a".repeat(64)
        ? Promise.resolve(raw)
        : Promise.reject(new Error(key)),
  });
  return { connection, thread, message, provider };
}

/** What a promise rejects with (undefined if it resolves). */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const subjects = (page: { items: { subject: string }[] }) =>
  page.items.map((m) => m.subject);

describe("Winston's mailbox provider", () => {
  test("lists by folder, newest first, with the flags and his own labels", async () => {
    await inRollback(db, async (tx) => {
      const { message, provider } = await mailbox(tx);
      await message({ subject: "Old", date: new Date("2026-09-01T12:00:00Z") });
      await message({
        subject: "New",
        labels: ["inbox", "starred", "receipts"],
      });
      await message({ subject: "Archived", labels: [] });
      await message({ subject: "Junk", labels: ["spam"] });
      await message({ subject: "Binned", labels: ["trash"] });
      await message({ subject: "Mine", direction: "sent", labels: [] });

      const inbox = await provider.list({}, { limit: 10 });
      expect(subjects(inbox)).toEqual(["New", "Old"]);
      expect(inbox.items[0]).toMatchObject({
        unread: false,
        starred: true,
        inInbox: true,
        labels: ["receipts"],
      });
      expect(
        subjects(await provider.list({ folder: "sent" }, { limit: 10 })),
      ).toEqual(["Mine"]);
      expect(
        new Set(
          subjects(await provider.list({ folder: "archive" }, { limit: 10 })),
        ),
      ).toEqual(new Set(["Archived", "Mine"]));
      expect(
        subjects(await provider.list({ folder: "all" }, { limit: 10 })),
      ).toHaveLength(4);
      expect(
        subjects(await provider.list({ folder: "drafts" }, { limit: 10 })),
      ).toEqual([]);
    });
  });

  test("the portable filters mean what they mean for Gmail", async () => {
    await inRollback(db, async (tx) => {
      const { message, provider } = await mailbox(tx);
      await message({
        subject: "Invoice 42",
        from: { name: "Billing", email: "billing@shop.example" },
        attachments: [
          {
            partId: "1",
            filename: "a.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        ],
        labels: ["inbox"],
      });
      await message({
        subject: "Lunch",
        cc: [{ name: "Fox", email: "fox@acme.example" }],
        date: new Date("2026-09-20T12:00:00Z"),
      });
      const find = async (filter: Parameters<typeof provider.list>[0]) =>
        subjects(
          await provider.list({ folder: "all", ...filter }, { limit: 10 }),
        );
      expect(await find({ from: "billing" })).toEqual(["Invoice 42"]);
      expect(await find({ from: "dana scully" })).toEqual(["Lunch"]);
      expect(await find({ to: "fox" })).toEqual(["Lunch"]);
      expect(await find({ subject: "invoice" })).toEqual(["Invoice 42"]);
      expect(await find({ text: "friday" })).toEqual(["Invoice 42", "Lunch"]);
      expect(await find({ unread: true })).toEqual(["Lunch"]);
      expect(await find({ unread: false })).toEqual(["Invoice 42"]);
      expect(await find({ hasAttachment: true })).toEqual(["Invoice 42"]);
      expect(await find({ since: new Date("2026-09-25T00:00:00Z") })).toEqual([
        "Invoice 42",
      ]);
      expect(await find({ until: new Date("2026-09-25T00:00:00Z") })).toEqual([
        "Lunch",
      ]);
      expect(await find({ category: "primary" })).toHaveLength(2);
      expect(await find({ category: "promotions" })).toEqual([]);
      expect(await find({ subject: "100%_" })).toEqual([]);
      expect(
        await rejection(provider.list({ native: "from:dana" }, { limit: 10 })),
      ).toBeInstanceOf(NotSupportedError);
    });
  });

  test("pages with a cursor, without repeats or gaps", async () => {
    await inRollback(db, async (tx) => {
      const { message, provider } = await mailbox(tx);
      const same = new Date("2026-10-01T12:00:00Z");
      for (const subject of ["a", "b", "c", "d", "e"])
        await message({ subject, date: same });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await provider.list(
          {},
          { limit: 2, ...(cursor ? { cursor } : {}) },
        );
        seen.push(...subjects(page));
        if (!page.cursor) break;
        cursor = page.cursor;
      }
      expect(seen.toSorted()).toEqual(["a", "b", "c", "d", "e"]);
    });
  });

  test("a message, a thread oldest first, and an attachment from the raw message", async () => {
    await inRollback(db, async (tx) => {
      const { message, provider, thread } = await mailbox(tx);
      const first = await message({
        date: new Date("2026-10-01T12:00:00Z"),
        messageIdHeader: "<1@acme>",
      });
      const reply = await message({
        date: new Date("2026-10-02T12:00:00Z"),
        body: "Noon.",
        references: ["<1@acme>"],
        attachments: [
          { partId: "1", filename: "menu.csv", mimeType: "text/csv", size: 10 },
        ],
      });
      expect(await provider.getMessage(first.id)).toMatchObject({
        providerId: first.id,
        body: "Friday?",
        messageIdHeader: "<1@acme>",
      });
      const got = await provider.getThread(thread?.id ?? "");
      expect(got.messages.map((m) => m.providerId)).toEqual([
        first.id,
        reply.id,
      ]);
      const attachment = await provider.getAttachment(`${reply.id}/1`);
      expect(attachment.filename).toBe("menu.csv");
      expect(new TextDecoder().decode(attachment.data)).toBe("dish,price");
      expect(
        await rejection(provider.getAttachment(`${reply.id}/2`)),
      ).toBeInstanceOf(ProviderNotFoundError);
      expect(await rejection(provider.getMessage("wmsg_nope"))).toBeInstanceOf(
        ProviderNotFoundError,
      );
    });
  });

  test("organizing: read, star, archive, his own labels and the trash", async () => {
    await inRollback(db, async (tx) => {
      const { message, provider, thread } = await mailbox(tx);
      const one = await message({});
      const two = await message({});
      const labelsOf = async (id: string) => await provider.getMessage(id);
      await provider.modify(
        { messages: [one.id] },
        { read: true, starred: true, addLabels: ["Receipts", "inbox"] },
      );
      expect(await labelsOf(one.id)).toMatchObject({
        unread: false,
        starred: true,
        inInbox: true,
        labels: ["receipts"],
      });
      await provider.modify(
        { threads: [thread?.id ?? ""] },
        { archived: true, removeLabels: ["receipts"] },
      );
      expect(await labelsOf(one.id)).toMatchObject({
        inInbox: false,
        labels: [],
      });
      expect(await labelsOf(two.id)).toMatchObject({ inInbox: false });
      await provider.trash({ messages: [two.id] });
      expect(
        subjects(await provider.list({ folder: "all" }, { limit: 10 })),
      ).toHaveLength(1);
      expect(
        await rejection(
          provider.send({ to: ["x@example.com"], subject: "s", body: "b" }),
        ),
      ).toBeInstanceOf(NotSupportedError);
    });
  });

  test("another mailbox's mail isn't reachable", async () => {
    await inRollback(db, async (tx) => {
      const ada = await mailbox(tx);
      const theirs = await ada.message({});
      const user = await insertUser(tx);
      await turnOnMailbox(tx, user.id, "bob");
      const [bob] = await tx
        .select()
        .from(connections)
        .where(eq(connections.userId, user.id));
      const provider = winstonMailProvider({
        db: tx,
        connection: bob ?? ada.connection,
        rawMessage: () => Promise.resolve(raw),
      });
      expect(await rejection(provider.getMessage(theirs.id))).toBeInstanceOf(
        ProviderNotFoundError,
      );
      expect(
        (await provider.list({ folder: "all" }, { limit: 10 })).items,
      ).toEqual([]);
      await provider.modify({ messages: [theirs.id] }, { read: true });
      expect((await ada.provider.getMessage(theirs.id)).unread).toBe(true);
    });
  });
});
