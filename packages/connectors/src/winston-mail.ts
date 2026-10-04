/**
 * Winston's own mailbox as a `MailProvider` (ead827, docs/design.md §3): we
 * are the provider, so reading and organizing are queries over
 * `mailbox_messages` and `mailbox_threads`, and attachments come out of the
 * raw message. The portable filters mean what they mean for Gmail; there's
 * no native query language. Sending goes through SES (`MailSender`), within
 * a daily limit and never to a suppressed address; what he sends is stored
 * in his mailbox too. He has no drafts: he sends once the user has agreed.
 */
import type { DbOrTx } from "@winston/db/client";
import {
  mailboxMessages,
  mailboxThreads,
  mailSuppressions,
  type connections,
} from "@winston/db/schema";
import { dailySendLimit } from "@winston/domain/mailbox";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  NotSupportedError,
  ProviderNotFoundError,
  SendingRefusedError,
} from "./errors.ts";
import { parseAddresses } from "./gmail.ts";
import type {
  FullMailMessage,
  MailFilter,
  MailMessage,
  MailProvider,
} from "./mail.ts";
import { composeRaw } from "./mail-compose.ts";
import { attachmentContent, parseMail } from "./mail-parse.ts";

/** Delivers a raw message: SES in production. */
export interface MailSender {
  /** Returns SES's id for the message, which is also its Message-ID. */
  send(
    raw: Uint8Array,
    envelope: { from: string; to: string[] },
  ): Promise<{ sesMessageId: string }>;
}

/**
 * The Message-ID SES gives a message it sends from us-east-1 (it replaces
 * any we set). Replies are threaded by the SES id inside it, so a different
 * host would still thread.
 */
export const sesMessageIdHeader = (sesMessageId: string) =>
  `<${sesMessageId}@email.amazonses.com>`;

type Row = typeof mailboxMessages.$inferSelect;

/** Labels that are state, not his own labels; the flags show them. */
const systemLabels = new Set(["inbox", "unread", "starred", "spam", "trash"]);

const noDrafts = () =>
  new NotSupportedError(
    "Winston's own mailbox has no drafts.",
    "Send it once the user has agreed, or draft in the user's account.",
  );

const dayMs = 24 * 60 * 60_000;

/** A row as the mail domain's message. */
function toMessage(row: Row): MailMessage {
  return {
    providerId: row.id,
    threadId: row.threadId,
    from: row.from,
    to: row.to,
    cc: row.cc,
    subject: row.subject,
    date: row.date,
    snippet: row.snippet,
    unread: row.labels.includes("unread"),
    starred: row.labels.includes("starred"),
    inInbox: row.labels.includes("inbox"),
    labels: row.labels.filter((label) => !systemLabels.has(label)),
    attachments: row.attachments.map((a) => ({
      providerId: `${row.id}/${a.partId}`,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    messageIdHeader: row.messageIdHeader,
  };
}

function toFullMessage(row: Row): FullMailMessage {
  return {
    ...toMessage(row),
    body: row.body,
    references: row.references,
    replyTo: row.replyTo,
    quotedTextHidden: row.quotedTextHidden,
  };
}

/** A `text[]` literal, one parameter per value. */
const textArray = (values: readonly string[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

const hasLabel = (label: string) =>
  sql`${mailboxMessages.labels} @> array[${label}]::text[]`;
const like = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;
const personLike = (column: SQL | typeof mailboxMessages.from, text: string) =>
  sql`${column}::text ilike ${like(text)}`;

/** The portable filters as conditions (`--native` has no meaning here). */
function conditions(filter: MailFilter): SQL[] {
  if (filter.native !== undefined)
    throw new NotSupportedError(
      "Winston's own mailbox has no native search syntax.",
      "Use the portable flags: --from, --to, --subject, --unread, --has-attachment, --label, --since, --until.",
    );
  const where: SQL[] = [];
  const outOfSight = or(hasLabel("trash"), hasLabel("spam"));
  switch (filter.folder ?? "inbox") {
    case "inbox":
      where.push(hasLabel("inbox"));
      break;
    case "sent":
      where.push(eq(mailboxMessages.direction, "sent"));
      break;
    case "drafts":
      // No drafts yet: nothing matches.
      where.push(sql`false`);
      break;
    case "archive":
      where.push(not(hasLabel("inbox")));
      if (outOfSight) where.push(not(outOfSight));
      break;
    case "all":
      if (outOfSight) where.push(not(outOfSight));
      break;
  }
  if (filter.text !== undefined) {
    const anywhere = or(
      ilike(mailboxMessages.subject, like(filter.text)),
      ilike(mailboxMessages.body, like(filter.text)),
      personLike(mailboxMessages.from, filter.text),
      personLike(
        sql`${mailboxMessages.to} || ${mailboxMessages.cc}`,
        filter.text,
      ),
    );
    if (anywhere) where.push(anywhere);
  }
  if (filter.from !== undefined)
    where.push(personLike(mailboxMessages.from, filter.from));
  if (filter.to !== undefined)
    where.push(
      personLike(
        sql`${mailboxMessages.to} || ${mailboxMessages.cc}`,
        filter.to,
      ),
    );
  if (filter.subject !== undefined)
    where.push(ilike(mailboxMessages.subject, like(filter.subject)));
  if (filter.unread !== undefined)
    where.push(filter.unread ? hasLabel("unread") : not(hasLabel("unread")));
  if (filter.hasAttachment !== undefined)
    where.push(
      filter.hasAttachment
        ? sql`jsonb_array_length(${mailboxMessages.attachments}) > 0`
        : sql`jsonb_array_length(${mailboxMessages.attachments}) = 0`,
    );
  if (filter.label !== undefined)
    where.push(hasLabel(filter.label.trim().toLowerCase()));
  // His mailbox has no tabs: everything is primary.
  if (filter.category !== undefined && filter.category !== "primary")
    where.push(sql`false`);
  if (filter.since !== undefined)
    where.push(gte(mailboxMessages.date, filter.since));
  if (filter.until !== undefined)
    where.push(lte(mailboxMessages.date, filter.until));
  return where;
}

/** A page's place: the last message's date and id, newest first. */
const encodeCursor = (row: Row) =>
  Buffer.from(`${row.date.toISOString()}|${row.id}`).toString("base64url");
function decodeCursor(cursor: string) {
  const [date, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(date ?? "");
  if (!id || Number.isNaN(at.getTime()))
    throw new ProviderNotFoundError("That page cursor isn't valid.");
  return { at, id };
}

export function winstonMailProvider({
  db,
  connection,
  rawMessage,
  sending,
}: {
  db: DbOrTx;
  connection: Pick<
    typeof connections.$inferSelect,
    "id" | "userId" | "externalEmail"
  >;
  /** The raw MIME stored under a blob key. */
  rawMessage: (blobKey: string) => Promise<Uint8Array>;
  /** Unset where sending isn't wired, as in some tests. */
  sending?: {
    sender: MailSender;
    /** Stores the raw message as a blob, returning its key. */
    storeRaw: (raw: Uint8Array) => Promise<string>;
    now?: () => Date;
  };
}): MailProvider {
  const mine = eq(mailboxMessages.connectionId, connection.id);

  async function rows(ids: readonly string[]) {
    if (ids.length === 0) return [];
    return db
      .select()
      .from(mailboxMessages)
      .where(and(mine, inArray(mailboxMessages.id, [...ids])));
  }

  async function one(messageId: string) {
    const [row] = await rows([messageId]);
    if (!row) throw new ProviderNotFoundError(`No message ${messageId}.`);
    return row;
  }

  /** The messages a target names: messages by id, and every message of each thread. */
  async function targetIds(target: {
    messages?: string[];
    threads?: string[];
  }) {
    const ids = new Set(target.messages ?? []);
    if (target.threads && target.threads.length > 0) {
      const inThreads = await db
        .select({ id: mailboxMessages.id })
        .from(mailboxMessages)
        .where(and(mine, inArray(mailboxMessages.threadId, target.threads)));
      for (const { id } of inThreads) ids.add(id);
    }
    return [...ids];
  }

  /** Refuses once he's sent `dailySendLimit` messages in the last 24 hours. */
  async function checkLimit(now: Date) {
    const [sent] = await db
      .select({ n: count() })
      .from(mailboxMessages)
      .where(
        and(
          mine,
          eq(mailboxMessages.direction, "sent"),
          gte(mailboxMessages.createdAt, new Date(now.getTime() - dayMs)),
        ),
      );
    if ((sent?.n ?? 0) >= dailySendLimit)
      throw new SendingRefusedError(
        `Winston has sent ${String(dailySendLimit)} messages from ${connection.externalEmail} in the last 24 hours, the most he may.`,
        "Send it later, or from the user's account.",
        "limit",
      );
  }

  /** Refuses recipients who bounced or complained before. */
  async function checkSuppressed(recipients: string[]) {
    if (recipients.length === 0) return;
    const suppressed = await db
      .select({ address: mailSuppressions.address })
      .from(mailSuppressions)
      .where(inArray(mailSuppressions.address, recipients));
    if (suppressed.length > 0)
      throw new SendingRefusedError(
        `Winston's address can't send to ${suppressed.map((s) => s.address).join(", ")}: mail to it bounced or was marked as spam before.`,
        "Leave them out, or send from the user's account.",
        "suppressed",
      );
  }

  /** The thread a sent message goes in: the one it answers, if it's his, else a new one. */
  async function sentThread(
    tx: DbOrTx,
    answering: string | undefined,
    subject: string,
    now: Date,
  ) {
    if (answering) {
      const [thread] = await tx
        .update(mailboxThreads)
        .set({ lastMessageAt: now })
        .where(
          and(
            eq(mailboxThreads.id, answering),
            eq(mailboxThreads.connectionId, connection.id),
          ),
        )
        .returning({ id: mailboxThreads.id });
      if (thread) return thread.id;
    }
    const [thread] = await tx
      .insert(mailboxThreads)
      .values({
        userId: connection.userId,
        connectionId: connection.id,
        subject,
        lastMessageAt: now,
      })
      .returning({ id: mailboxThreads.id });
    if (!thread) throw new Error("expected the new thread");
    return thread.id;
  }

  /** Adds and removes labels on messages of this mailbox, each at most once. */
  async function relabel(ids: string[], add: string[], remove: string[]) {
    if (ids.length === 0 || (add.length === 0 && remove.length === 0)) return;
    await db
      .update(mailboxMessages)
      .set({
        labels: sql`array(
          select distinct label from unnest(${mailboxMessages.labels} || ${textArray(add)}) as label
          where label <> all(${textArray(remove)})
          order by label
        )`,
      })
      .where(and(mine, inArray(mailboxMessages.id, ids)));
  }

  return {
    address: connection.externalEmail,

    async list(filter, { limit, cursor }) {
      const where = [mine, ...conditions(filter)];
      if (cursor) {
        const after = decodeCursor(cursor);
        const older = or(
          lt(mailboxMessages.date, after.at),
          and(
            eq(mailboxMessages.date, after.at),
            lt(mailboxMessages.id, after.id),
          ),
        );
        if (older) where.push(older);
      }
      const found = await db
        .select()
        .from(mailboxMessages)
        .where(and(...where))
        .orderBy(desc(mailboxMessages.date), desc(mailboxMessages.id))
        .limit(limit + 1);
      const page = found.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(toMessage),
        cursor: found.length > limit && last ? encodeCursor(last) : null,
        estimatedTotal: null,
      };
    },

    async getMessage(messageId) {
      return toFullMessage(await one(messageId));
    },

    async getThread(threadId) {
      const [thread] = await db
        .select()
        .from(mailboxThreads)
        .where(
          and(
            eq(mailboxThreads.id, threadId),
            eq(mailboxThreads.connectionId, connection.id),
          ),
        );
      if (!thread) throw new ProviderNotFoundError(`No thread ${threadId}.`);
      const messages = await db
        .select()
        .from(mailboxMessages)
        .where(and(mine, eq(mailboxMessages.threadId, threadId)))
        .orderBy(asc(mailboxMessages.date), asc(mailboxMessages.id));
      return {
        providerId: thread.id,
        subject: thread.subject,
        messages: messages.map(toFullMessage),
      };
    },

    async getAttachment(attachmentId) {
      const slash = attachmentId.lastIndexOf("/");
      const row = await one(attachmentId.slice(0, slash));
      const part = attachmentId.slice(slash + 1);
      const found = row.attachments.some((a) => a.partId === part)
        ? await attachmentContent(await rawMessage(row.rawBlobKey), part)
        : undefined;
      if (!found)
        throw new ProviderNotFoundError(`No attachment ${attachmentId}.`);
      return {
        filename: found.filename,
        mimeType: found.mimeType,
        data: found.content,
      };
    },

    async modify(target, changes) {
      const ids = await targetIds(target);
      const add: string[] = [];
      const remove: string[] = [];
      const flag = (on: boolean | undefined, label: string) => {
        if (on === true) add.push(label);
        if (on === false) remove.push(label);
      };
      flag(changes.read === undefined ? undefined : !changes.read, "unread");
      flag(changes.starred, "starred");
      flag(
        changes.archived === undefined ? undefined : !changes.archived,
        "inbox",
      );
      const own = (labels: string[] | undefined) =>
        (labels ?? [])
          .map((label) => label.trim().toLowerCase())
          .filter((label) => label !== "" && !systemLabels.has(label));
      add.push(...own(changes.addLabels));
      remove.push(...own(changes.removeLabels));
      await relabel(ids, add, remove);
    },

    async trash(target) {
      if (target.drafts && target.drafts.length > 0) throw noDrafts();
      await relabel(await targetIds(target), ["trash"], ["inbox"]);
    },

    async send(mail) {
      if (!sending)
        throw new NotSupportedError("Sending isn't available here.");
      const now = sending.now?.() ?? new Date();
      const recipients = [
        ...new Set(
          [...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])]
            .flatMap((r) => parseAddresses(r))
            .map((a) => a.email.toLowerCase()),
        ),
      ];
      await checkLimit(now);
      await checkSuppressed(recipients);

      const from = connection.externalEmail;
      const raw = await composeRaw(mail, {
        from: `Winston <${from}>`,
        // SES delivers to the envelope's recipients; Bcc stays out of the headers.
        keepBcc: false,
        date: now,
      });
      const { sesMessageId } = await sending.sender.send(raw, {
        from,
        to: recipients,
      });
      // Sent: from here on, storing it must not make it look unsent.
      const rawBlobKey = await sending.storeRaw(raw);
      const parsed = await parseMail(raw);
      return db.transaction(async (tx) => {
        const threadId = await sentThread(
          tx,
          mail.inReplyTo?.threadId,
          parsed.subject,
          now,
        );
        const [row] = await tx
          .insert(mailboxMessages)
          .values({
            userId: connection.userId,
            connectionId: connection.id,
            threadId,
            direction: "sent",
            sesMessageId,
            messageIdHeader: sesMessageIdHeader(sesMessageId),
            inReplyTo: parsed.inReplyTo,
            references: parsed.references,
            from: { name: "Winston", email: from },
            to: parsed.to,
            cc: parsed.cc,
            replyTo: [],
            subject: parsed.subject,
            date: now,
            body: parsed.body,
            quotedTextHidden: parsed.quotedTextHidden,
            snippet: parsed.snippet,
            attachments: parsed.attachments.map((a) => ({
              partId: a.providerId,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
            labels: [],
            rawBlobKey,
            size: raw.byteLength,
          })
          .returning({ id: mailboxMessages.id });
        if (!row) throw new Error("expected the sent message");
        return { messageId: row.id, threadId };
      });
    },
    createDraft: () => Promise.reject(noDrafts()),
    sendDraft: () => Promise.reject(noDrafts()),
    getDraft: () => Promise.reject(noDrafts()),
  };
}
