/**
 * Mail arriving at Winston's own addresses (ead827, docs/design.md §3). SES
 * writes each message to the inbound store and the api queues
 * `receive_mail`; this stores it in each mailbox it's addressed to, emits
 * `mail.message.received` through the usual matching, and bounces it for
 * addresses no mailbox takes.
 */
import { parseMail, type ParsedMail } from "@winston/connectors/mail-parse";
import type { DbOrTx } from "@winston/db/client";
import { refsFor } from "@winston/db/external-refs";
import {
  connections,
  events,
  mailboxAddresses,
  mailboxMessages,
  mailboxThreads,
} from "@winston/db/schema";
import { parseEventPayload } from "@winston/domain/events";
import type { ReceiveMailPayload } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "../blobs.ts";
import { matchEvents } from "../triggers/matching.ts";
import type { JobHandler } from "../worker.ts";

type Connection = typeof connections.$inferSelect;

/** Where SES leaves raw messages: the inbound bucket, or a directory locally. */
export interface InboundMailStore {
  /** The raw message, or undefined if it's gone (already handled). */
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

/** Tells a sender their message wasn't delivered (SES's SendBounce). */
export interface MailBouncer {
  bounce(input: { sesMessageId: string; recipients: string[] }): Promise<void>;
}

export interface ReceiveMailDeps {
  inbound: InboundMailStore;
  blobs: BlobStore;
  bouncer: MailBouncer;
}

const verdict = z.string();
const payloadSchema: z.ZodType<ReceiveMailPayload> = z.object({
  key: z.string().min(1),
  sesMessageId: z.string().min(1),
  recipients: z.array(z.string()),
  verdicts: z.object({
    spf: verdict,
    dkim: verdict,
    dmarc: verdict,
    spam: verdict,
    virus: verdict,
  }),
});

export function receiveMailHandler(deps: ReceiveMailDeps): JobHandler {
  return async ({ job, db, logger }) => {
    const payload = payloadSchema.parse(job.payload);
    const stored = await receiveMail(db, deps, payload, logger);
    await matchEvents(db, stored, { logger });
  };
}

/** The mailboxes, on, that each recipient address belongs to. */
async function mailboxesFor(db: DbOrTx, recipients: readonly string[]) {
  const wanted = [...new Set(recipients.map((r) => r.trim().toLowerCase()))];
  if (wanted.length === 0) return { found: [], missing: [] };
  const rows = await db
    .select({ address: mailboxAddresses.address, connection: connections })
    .from(mailboxAddresses)
    .innerJoin(connections, eq(connections.id, mailboxAddresses.connectionId))
    .where(
      and(
        inArray(mailboxAddresses.address, wanted),
        eq(connections.status, "ok"),
      ),
    );
  const byAddress = new Map(rows.map((r) => [r.address, r.connection]));
  const found = [
    ...new Map(rows.map((r) => [r.connection.id, r.connection])).values(),
  ];
  return { found, missing: wanted.filter((a) => !byAddress.has(a)) };
}

/**
 * Handles one received message and returns the events it stored. Safe to
 * run again: a message already stored isn't stored twice, and once the raw
 * message is gone there's nothing left to do.
 */
export async function receiveMail(
  db: DbOrTx,
  deps: ReceiveMailDeps,
  payload: ReceiveMailPayload,
  logger: Logger,
  now = new Date(),
) {
  const raw = await deps.inbound.get(payload.key);
  if (!raw) {
    logger.info({ sesMessageId: payload.sesMessageId }, "mail already handled");
    return [];
  }
  // Infected mail is dropped, not bounced: its sender is likely forged.
  if (payload.verdicts.virus === "FAIL") {
    logger.warn(
      { sesMessageId: payload.sesMessageId },
      "dropped infected mail",
    );
    await deps.inbound.delete(payload.key);
    return [];
  }

  const { found, missing } = await mailboxesFor(db, payload.recipients);
  const stored: (typeof events.$inferSelect)[] = [];
  if (found.length > 0) {
    const parsed = await parseMail(raw);
    const rawBlobKey = await deps.blobs.put(raw);
    for (const connection of found) {
      const event = await db.transaction((tx) =>
        storeReceived(tx, connection, parsed, {
          sesMessageId: payload.sesMessageId,
          verdicts: payload.verdicts,
          rawBlobKey,
          size: raw.byteLength,
          now,
        }),
      );
      if (event) stored.push(event);
    }
  }
  if (missing.length > 0) {
    await deps.bouncer.bounce({
      sesMessageId: payload.sesMessageId,
      recipients: missing,
    });
    logger.info(
      { sesMessageId: payload.sesMessageId, recipients: missing.length },
      "bounced mail for addresses no mailbox takes",
    );
  }
  await deps.inbound.delete(payload.key);
  return stored;
}

/** The thread a message belongs to: the one holding what it replies to. */
async function threadFor(
  tx: DbOrTx,
  connection: Connection,
  parsed: ParsedMail,
  date: Date,
) {
  const earlier = [parsed.inReplyTo, ...parsed.references].filter(
    (id): id is string => id !== null,
  );
  if (earlier.length > 0) {
    const [known] = await tx
      .select({ threadId: mailboxMessages.threadId })
      .from(mailboxMessages)
      .where(
        and(
          eq(mailboxMessages.connectionId, connection.id),
          inArray(mailboxMessages.messageIdHeader, earlier),
        ),
      )
      .orderBy(desc(mailboxMessages.date))
      .limit(1);
    if (known) return known.threadId;
  }
  const [thread] = await tx
    .insert(mailboxThreads)
    .values({
      userId: connection.userId,
      connectionId: connection.id,
      subject: parsed.subject,
      lastMessageAt: date,
    })
    .returning({ id: mailboxThreads.id });
  if (!thread) throw new Error("expected the new thread");
  return thread.id;
}

/**
 * Stores a received message in one mailbox and its event (none for spam, or
 * when it's already stored). Returns the stored event.
 */
async function storeReceived(
  tx: DbOrTx,
  connection: Connection,
  parsed: ParsedMail,
  received: {
    sesMessageId: string;
    verdicts: ReceiveMailPayload["verdicts"];
    rawBlobKey: string;
    size: number;
    now: Date;
  },
) {
  const [already] = await tx
    .select({ id: mailboxMessages.id })
    .from(mailboxMessages)
    .where(
      and(
        eq(mailboxMessages.connectionId, connection.id),
        eq(mailboxMessages.sesMessageId, received.sesMessageId),
      ),
    );
  if (already) return undefined;

  const date = parsed.date ?? received.now;
  const spam = received.verdicts.spam === "FAIL";
  const threadId = await threadFor(tx, connection, parsed, date);
  const [message] = await tx
    .insert(mailboxMessages)
    .values({
      userId: connection.userId,
      connectionId: connection.id,
      threadId,
      direction: "received",
      sesMessageId: received.sesMessageId,
      messageIdHeader: parsed.messageIdHeader,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      subject: parsed.subject,
      date,
      body: parsed.body,
      quotedTextHidden: parsed.quotedTextHidden,
      snippet: parsed.snippet,
      attachments: parsed.attachments.map((a) => ({
        partId: a.providerId,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
      labels: spam ? ["spam"] : ["inbox", "unread"],
      rawBlobKey: received.rawBlobKey,
      size: received.size,
      verdicts: received.verdicts,
    })
    .returning({ id: mailboxMessages.id });
  if (!message) throw new Error("expected the new message");
  await tx
    .update(mailboxThreads)
    .set({
      lastMessageAt: sql`greatest(${mailboxThreads.lastMessageAt}, ${date.toISOString()}::timestamptz)`,
    })
    .where(eq(mailboxThreads.id, threadId));
  // Spam is kept, like Gmail's, but isn't news.
  if (spam) return undefined;

  const [previous] = await tx
    .select({ direction: mailboxMessages.direction })
    .from(mailboxMessages)
    .where(
      and(
        eq(mailboxMessages.threadId, threadId),
        lt(mailboxMessages.date, date),
      ),
    )
    .orderBy(desc(mailboxMessages.date), asc(mailboxMessages.id))
    .limit(1);
  const [messageRefs, threadRefs] = await Promise.all([
    refsFor(tx, connection.userId, connection.id, "message", [message.id]),
    refsFor(tx, connection.userId, connection.id, "thread", [threadId]),
  ]);
  const type = "mail.message.received";
  const [event] = await tx
    .insert(events)
    .values({
      userId: connection.userId,
      connectionId: connection.id,
      type,
      payload: parseEventPayload(type, {
        messageId: messageRefs.get(message.id) ?? "",
        threadId: threadRefs.get(threadId) ?? "",
        account: connection.externalEmail,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        subject: parsed.subject,
        snippet: parsed.snippet,
        date: date.toISOString(),
        labels: [],
        // His mailbox has no tabs: everything is primary.
        category: "primary",
        unread: true,
        hasAttachments: parsed.attachments.length > 0,
        // For his own mailbox, "the user" is Winston: a reply to his message.
        isReplyToUser: previous?.direction === "sent",
      }),
      occurredAt: date,
      dedupeKey: `mail:${connection.id}:${received.sesMessageId}:received`,
      selfCaused: false,
    })
    .onConflictDoNothing({ target: events.dedupeKey })
    .returning();
  return event;
}
