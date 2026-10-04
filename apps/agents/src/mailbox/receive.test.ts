import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DbOrTx } from "@winston/db/client";
import {
  changeMailboxAddress,
  turnOffMailbox,
  turnOnMailbox,
} from "@winston/db/mailbox";
import type { Job } from "@winston/db/queue";
import {
  connections,
  events,
  mailboxMessages,
  mailboxThreads,
  triggerBatches,
  triggers,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import type { ReceiveMailPayload } from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { asc, eq } from "drizzle-orm";
import { localBlobStore } from "../blobs.ts";
import { receiveMail, receiveMailHandler } from "./receive.ts";
import { localInboundMailStore } from "./stores.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

/** A synthetic message, written by hand: no one's real mail is in the repository. */
const message = (headers: Record<string, string>, body = "Hello there.") =>
  new TextEncoder().encode(
    [
      ...Object.entries({
        From: '"Dana Scully" <dana@acme.example>',
        To: "ada@runwinston.email",
        Subject: "Lunch on Friday",
        Date: "Fri, 02 Oct 2026 14:05:00 -0400",
        "Message-ID": "<first@acme.example>",
        ...headers,
      }).map(([name, value]) => `${name}: ${value}`),
      "",
      body,
      "",
    ].join("\r\n"),
  );

const pass = {
  spf: "PASS",
  dkim: "PASS",
  dmarc: "PASS",
  spam: "PASS",
  virus: "PASS",
};

async function setup() {
  const inbound = localInboundMailStore(
    await mkdtemp(`${tmpdir()}/winston-inbound-`),
  );
  const blobs = localBlobStore(await mkdtemp(`${tmpdir()}/winston-blobs-`));
  const bounced: { sesMessageId: string; recipients: string[] }[] = [];
  const deps = {
    inbound,
    blobs,
    bouncer: {
      bounce: (input: { sesMessageId: string; recipients: string[] }) => {
        bounced.push(input);
        return Promise.resolve();
      },
    },
  };
  /** Leaves a raw message where SES would, and the payload it would announce. */
  const arrive = async (
    sesMessageId: string,
    raw: Uint8Array,
    recipients: string[],
    verdicts: Partial<ReceiveMailPayload["verdicts"]> = {},
  ): Promise<ReceiveMailPayload> => {
    const key = `inbound/${sesMessageId}`;
    await inbound.put(key, raw);
    return {
      key,
      sesMessageId,
      recipients,
      verdicts: { ...pass, ...verdicts },
    };
  };
  return { deps, inbound, blobs, bounced, arrive };
}

async function mailbox(tx: DbOrTx, name = "ada") {
  const user = await insertUser(tx);
  await turnOnMailbox(tx, user.id, name);
  const [connection] = await tx
    .select()
    .from(connections)
    .where(eq(connections.userId, user.id));
  if (!connection) throw new Error("expected the mailbox");
  return { user, connection };
}

const messagesOf = (tx: DbOrTx, connectionId: string) =>
  tx
    .select()
    .from(mailboxMessages)
    .where(eq(mailboxMessages.connectionId, connectionId))
    .orderBy(asc(mailboxMessages.date));

describe("receiving mail", () => {
  test("a message to his address is stored, threaded and becomes mail.message.received", async () => {
    await inRollback(db, async (tx) => {
      const { connection } = await mailbox(tx);
      const { deps, inbound, blobs, arrive } = await setup();
      const raw = message({});
      const stored = await receiveMail(
        tx,
        deps,
        await arrive("ses-1", raw, ["Ada@RunWinston.email"]),
        logger,
      );

      const [row] = await messagesOf(tx, connection.id);
      expect(row).toMatchObject({
        direction: "received",
        sesMessageId: "ses-1",
        messageIdHeader: "<first@acme.example>",
        from: { name: "Dana Scully", email: "dana@acme.example" },
        subject: "Lunch on Friday",
        body: "Hello there.",
        labels: ["inbox", "unread"],
        size: raw.byteLength,
        verdicts: pass,
      });
      // The raw message moved to blob storage; the inbound copy is gone.
      expect(await blobs.get(row?.rawBlobKey ?? "")).toEqual(raw);
      expect(await inbound.get("inbound/ses-1")).toBeUndefined();

      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        type: "mail.message.received",
        connectionId: connection.id,
        selfCaused: false,
        payload: {
          account: "ada@runwinston.email",
          subject: "Lunch on Friday",
          snippet: "Hello there.",
          category: "primary",
          unread: true,
          hasAttachments: false,
          isReplyToUser: false,
          date: "2026-10-02T18:05:00.000Z",
        },
      });
      const payload = stored[0]?.payload as {
        messageId: string;
        threadId: string;
      };
      expect(payload.messageId).toStartWith("msg_");
      expect(payload.threadId).toStartWith("thr_");
    });
  });

  test("a reply joins its thread, and a reply to Winston's own message says so", async () => {
    await inRollback(db, async (tx) => {
      const { connection } = await mailbox(tx);
      const { deps, arrive } = await setup();
      await receiveMail(
        tx,
        deps,
        await arrive("ses-1", message({}), ["ada@runwinston.email"]),
        logger,
      );
      const [first] = await messagesOf(tx, connection.id);
      // Winston answered (sending comes with 201a9b; here it's a row).
      await tx.insert(mailboxMessages).values({
        userId: connection.userId,
        connectionId: connection.id,
        threadId: first?.threadId ?? "",
        direction: "sent",
        messageIdHeader: "<winston-1@runwinston.email>",
        inReplyTo: "<first@acme.example>",
        references: ["<first@acme.example>"],
        subject: "Re: Lunch on Friday",
        date: new Date("2026-10-02T19:00:00Z"),
        body: "Noon?",
        snippet: "Noon?",
        rawBlobKey: "0".repeat(64),
        size: 10,
      });
      const stored = await receiveMail(
        tx,
        deps,
        await arrive(
          "ses-2",
          message({
            Subject: "Re: Lunch on Friday",
            Date: "Fri, 02 Oct 2026 16:00:00 -0400",
            "Message-ID": "<second@acme.example>",
            "In-Reply-To": "<winston-1@runwinston.email>",
            References: "<first@acme.example> <winston-1@runwinston.email>",
          }),
          ["ada@runwinston.email"],
        ),
        logger,
      );
      const rows = await messagesOf(tx, connection.id);
      expect(new Set(rows.map((r) => r.threadId)).size).toBe(1);
      expect(stored[0]?.payload).toMatchObject({ isReplyToUser: true });
      const [thread] = await tx
        .select()
        .from(mailboxThreads)
        .where(eq(mailboxThreads.id, first?.threadId ?? ""));
      expect(thread?.subject).toBe("Lunch on Friday");
      expect(thread?.lastMessageAt).toEqual(new Date("2026-10-02T20:00:00Z"));

      // Something unrelated starts its own thread.
      await receiveMail(
        tx,
        deps,
        await arrive(
          "ses-3",
          message({ "Message-ID": "<other@acme.example>", Subject: "Hi" }),
          ["ada@runwinston.email"],
        ),
        logger,
      );
      expect(
        new Set((await messagesOf(tx, connection.id)).map((r) => r.threadId))
          .size,
      ).toBe(2);
    });
  });

  test("an old address still delivers; addresses no mailbox takes are bounced", async () => {
    await inRollback(db, async (tx) => {
      const { user, connection } = await mailbox(tx, "ada");
      await changeMailboxAddress(tx, user.id, "ada.l");
      const off = await mailbox(tx, "bob");
      await turnOffMailbox(tx, off.user.id);
      const { deps, bounced, arrive, inbound } = await setup();
      await receiveMail(
        tx,
        deps,
        await arrive("ses-1", message({}), [
          "ada@runwinston.email",
          "ada.l@runwinston.email",
          "bob@runwinston.email",
          "nobody@runwinston.email",
        ]),
        logger,
      );
      // Both of Ada's addresses are one mailbox: stored once.
      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      expect(await messagesOf(tx, off.connection.id)).toHaveLength(0);
      expect(bounced).toEqual([
        {
          sesMessageId: "ses-1",
          recipients: ["bob@runwinston.email", "nobody@runwinston.email"],
        },
      ]);
      expect(await inbound.get("inbound/ses-1")).toBeUndefined();
    });
  });

  test("a message announced twice is stored once", async () => {
    await inRollback(db, async (tx) => {
      const { connection } = await mailbox(tx);
      const { deps, arrive } = await setup();
      const payload = await arrive("ses-1", message({}), [
        "ada@runwinston.email",
      ]);
      await receiveMail(tx, deps, payload, logger);
      // Gone already: nothing to do.
      expect(await receiveMail(tx, deps, payload, logger)).toEqual([]);
      // Delivered again by SES with the same id: still once.
      expect(
        await receiveMail(
          tx,
          deps,
          await arrive("ses-1", message({}), ["ada@runwinston.email"]),
          logger,
        ),
      ).toEqual([]);
      expect(await messagesOf(tx, connection.id)).toHaveLength(1);
      const stored = await tx
        .select()
        .from(events)
        .where(eq(events.connectionId, connection.id));
      expect(stored.filter((e) => e.type.startsWith("mail."))).toHaveLength(1);
    });
  });

  test("spam is kept without an event; infected mail is dropped", async () => {
    await inRollback(db, async (tx) => {
      const { connection } = await mailbox(tx);
      const { deps, bounced, arrive, inbound } = await setup();
      expect(
        await receiveMail(
          tx,
          deps,
          await arrive("ses-spam", message({}), ["ada@runwinston.email"], {
            spam: "FAIL",
          }),
          logger,
        ),
      ).toEqual([]);
      expect(
        await receiveMail(
          tx,
          deps,
          await arrive(
            "ses-virus",
            message({ "Message-ID": "<v@x>" }),
            ["ada@runwinston.email"],
            { virus: "FAIL" },
          ),
          logger,
        ),
      ).toEqual([]);
      const rows = await messagesOf(tx, connection.id);
      expect(rows.map((r) => [r.sesMessageId, r.labels])).toEqual([
        ["ses-spam", ["spam"]],
      ]);
      expect(await inbound.get("inbound/ses-virus")).toBeUndefined();
      expect(bounced).toEqual([]);
    });
  });

  test("the job matches his subscriptions", async () => {
    await inRollback(db, async (tx) => {
      const { user, connection } = await mailbox(tx);
      const [trigger] = await tx
        .insert(triggers)
        .values({
          userId: user.id,
          kind: "subscription",
          eventType: "mail.message.received",
          connectionId: connection.id,
          filter: { from: "dana" },
          note: "Codes from Dana",
        })
        .returning();
      const { deps, arrive } = await setup();
      await receiveMailHandler(deps)({
        job: {
          id: "job_1",
          payload: await arrive("ses-1", message({}), ["ada@runwinston.email"]),
        } as unknown as Job,
        db: tx as never,
        logger,
        extendLease: () => Promise.resolve(true),
      });
      const batches = await tx
        .select()
        .from(triggerBatches)
        .where(eq(triggerBatches.triggerId, trigger?.id ?? ""));
      expect(batches).toHaveLength(1);
    });
  });
});
