/**
 * Winston's own mailbox as a `MailProvider` (ead827, docs/design.md §3): we
 * are the provider, so reading and organizing are queries over
 * `mailbox_messages` and `mailbox_threads`, and attachments come out of the
 * raw message. The portable filters mean what they mean for Gmail; there's
 * no native query language. Sending comes with 201a9b.
 */
import type { DbOrTx } from "@winston/db/client";
import {
  mailboxMessages,
  mailboxThreads,
  type connections,
} from "@winston/db/schema";
import {
  and,
  asc,
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
import { NotSupportedError, ProviderNotFoundError } from "./errors.ts";
import type {
  FullMailMessage,
  MailFilter,
  MailMessage,
  MailProvider,
} from "./mail.ts";
import { attachmentContent } from "./mail-parse.ts";

type Row = typeof mailboxMessages.$inferSelect;

/** Labels that are state, not his own labels; the flags show them. */
const systemLabels = new Set(["inbox", "unread", "starred", "spam", "trash"]);

const notSending = () =>
  new NotSupportedError(
    "Winston's own mailbox can't send yet.",
    "Read and organize it for now.",
  );

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
}: {
  db: DbOrTx;
  connection: Pick<typeof connections.$inferSelect, "id" | "externalEmail">;
  /** The raw MIME stored under a blob key. */
  rawMessage: (blobKey: string) => Promise<Uint8Array>;
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
      if (target.drafts && target.drafts.length > 0) throw notSending();
      await relabel(await targetIds(target), ["trash"], ["inbox"]);
    },

    send: () => Promise.reject(notSending()),
    createDraft: () => Promise.reject(notSending()),
    sendDraft: () => Promise.reject(notSending()),
    getDraft: () => Promise.reject(notSending()),
  };
}
