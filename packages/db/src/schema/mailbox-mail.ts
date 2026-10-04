import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  jsonb,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { connections } from "./connections.ts";
import { users } from "./users.ts";

/** Someone in a message's headers. */
export interface StoredMailAddress {
  name: string | null;
  email: string;
}

/** An attachment's facts; its bytes stay in the raw message. */
export interface StoredMailAttachment {
  /** The MIME part's number in the raw message (`attachmentContent`). */
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** SES's verdicts on a received message: PASS, FAIL, GRAY or PROCESSING_FAILED. */
export interface MailVerdicts {
  spf: string;
  dkim: string;
  dmarc: string;
  spam: string;
  virus: string;
}

export const mailDirection = pgEnum("mail_direction", ["received", "sent"]);

/**
 * A conversation in Winston's own mailbox (ead827). We are the provider
 * here, so these rows are the provider's objects: the CLI names them by
 * `thr_` ids through `external_refs`, as it does Gmail's.
 */
export const mailboxThreads = snakeCase.table(
  "mailbox_threads",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("mailboxThread")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** The first message's subject. */
    subject: text().notNull(),
    lastMessageAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("mailbox_threads_recent").on(t.connectionId, t.lastMessageAt)],
);

/**
 * A message in Winston's own mailbox, received or sent. The raw MIME is a
 * blob (`raw_blob_key`), the record and the source of attachments; the
 * columns are what reading, searching and threading need.
 */
export const mailboxMessages = snakeCase.table(
  "mailbox_messages",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("mailboxMessage")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    threadId: text()
      .notNull()
      .references(() => mailboxThreads.id, { onDelete: "cascade" }),
    direction: mailDirection().notNull(),
    /** SES's id for a received message, so a redelivered one is stored once. */
    sesMessageId: text(),
    /** The RFC 5322 Message-ID. */
    messageIdHeader: text(),
    inReplyTo: text(),
    references: text().array().notNull().default([]),
    from: jsonb().$type<StoredMailAddress | null>(),
    to: jsonb().$type<StoredMailAddress[]>().notNull().default([]),
    cc: jsonb().$type<StoredMailAddress[]>().notNull().default([]),
    replyTo: jsonb().$type<StoredMailAddress[]>().notNull().default([]),
    subject: text().notNull(),
    /** The Date header, or when it arrived if that's missing or wrong. */
    date: timestamp({ withTimezone: true }).notNull(),
    /** Plain text, or the HTML as text, as Winston reads it. */
    body: text().notNull(),
    quotedTextHidden: boolean().notNull().default(false),
    snippet: text().notNull(),
    attachments: jsonb().$type<StoredMailAttachment[]>().notNull().default([]),
    /** `inbox`, `unread`, `starred`, `spam`, `trash` and his own labels. */
    labels: text().array().notNull().default([]),
    rawBlobKey: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    verdicts: jsonb().$type<MailVerdicts>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mailbox_messages_ses_id")
      .on(t.connectionId, t.sesMessageId)
      .where(sql`ses_message_id is not null`),
    index("mailbox_messages_header_id").on(t.connectionId, t.messageIdHeader),
    index("mailbox_messages_thread").on(t.threadId, t.date),
  ],
);
