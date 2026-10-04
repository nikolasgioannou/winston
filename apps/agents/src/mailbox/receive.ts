/**
 * Mail arriving at Winston's own addresses (ead827, docs/design.md §3). SES
 * writes each message to the inbound store and the api queues
 * `receive_mail`; this stores it in each mailbox it's addressed to, emits
 * `mail.message.received` through the usual matching, and bounces it for
 * addresses no mailbox takes.
 */
import { splitForwarded } from "@winston/connectors/mail-body";
import { parseMail, type ParsedMail } from "@winston/connectors/mail-parse";
import type { DbOrTx } from "@winston/db/client";
import { refsFor } from "@winston/db/external-refs";
import {
  connections,
  events,
  mailboxAddresses,
  mailboxMessages,
  mailboxThreads,
  users,
} from "@winston/db/schema";
import { recordSystemEvent } from "@winston/db/system-events";
import { parseEventPayload } from "@winston/domain/events";
import type { ReceiveMailPayload } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { BlobStore } from "@winston/blobs";
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

/**
 * Whether an address is the user's own: their sign-in email, or a mail
 * account they've connected (not his).
 */
async function isUsersAddress(tx: DbOrTx, userId: string, email: string) {
  const wanted = email.trim().toLowerCase();
  const [user] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (user?.email.toLowerCase() === wanted) return true;
  const [connected] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.domain, "mail"),
        ne(connections.provider, "winston"),
        ne(connections.status, "disconnected"),
        eq(connections.externalEmail, wanted),
      ),
    );
  return connected !== undefined;
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
  // SES gives what Winston sends its own Message-ID (`<id@….amazonses.com>`):
  // match those by the SES id, whatever host it names.
  const sentIds = earlier.flatMap((id) => {
    const ses = /^<([^@>]+)@(?:[a-z0-9-]+\.)*amazonses\.com>$/i.exec(id);
    return ses?.[1] ? [ses[1]] : [];
  });
  if (earlier.length > 0) {
    const named = or(
      inArray(mailboxMessages.messageIdHeader, earlier),
      ...(sentIds.length > 0
        ? [
            and(
              eq(mailboxMessages.direction, "sent"),
              inArray(mailboxMessages.sesMessageId, sentIds),
            ),
          ]
        : []),
    );
    const [known] = await tx
      .select({ threadId: mailboxMessages.threadId })
      .from(mailboxMessages)
      .where(and(eq(mailboxMessages.connectionId, connection.id), named))
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

  const [messageRefs, threadRefs] = await Promise.all([
    refsFor(tx, connection.userId, connection.id, "message", [message.id]),
    refsFor(tx, connection.userId, connection.id, "thread", [threadId]),
  ]);
  const ids = {
    messageId: messageRefs.get(message.id) ?? "",
    threadId: threadRefs.get(threadId) ?? "",
  };

  // From the user: proven, it's them speaking; unproven, someone may be
  // posing as them, and it's outside mail like any other.
  if (
    parsed.from &&
    (await isUsersAddress(tx, connection.userId, parsed.from.email))
  ) {
    const { dkim, dmarc } = received.verdicts;
    if (dkim === "PASS" && dmarc === "PASS") {
      const { own, forwarded } = splitForwarded(parsed.body);
      await recordSystemEvent(tx, {
        userId: connection.userId,
        type: "user_email",
        payload: {
          account: connection.externalEmail,
          from: parsed.from,
          to: parsed.to,
          cc: parsed.cc,
          subject: parsed.subject,
          ...ids,
          text: own,
          forwarded,
          attachments: parsed.attachments.map((a) => a.filename),
        },
        sourceRef: `mail:${connection.id}:${received.sesMessageId}:user`,
      });
      // It reaches the front of house as the user; it isn't also news.
      return undefined;
    }
    await recordSystemEvent(tx, {
      userId: connection.userId,
      type: "mail.impersonation.suspected",
      payload: {
        account: connection.externalEmail,
        claimedFrom: parsed.from.email,
        subject: parsed.subject,
        ...ids,
        dkim,
        dmarc,
      },
      sourceRef: `mail:${connection.id}:${received.sesMessageId}:impersonation`,
    });
  }

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
  const type = "mail.message.received";
  const [event] = await tx
    .insert(events)
    .values({
      userId: connection.userId,
      connectionId: connection.id,
      type,
      payload: parseEventPayload(type, {
        ...ids,
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
