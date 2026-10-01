/**
 * Mail sync (docs/design.md §3, §17 event pipeline steps 2–4): everything in
 * Gmail's history since the stored checkpoint becomes catalog events. New
 * inbox messages are `mail.message.received`, the user's own are
 * `mail.message.sent`, and read/star/archive/label changes are
 * `mail.message.labels_changed`. Events are stored with dedupe keys, so a
 * re-sync repeats nothing, and the checkpoint moves only in the same
 * transaction that stores them.
 */
import {
  HistoryExpiredError,
  type HistoryMessage,
  type gmailSync,
} from "@winston/connectors/gmail-sync";
import { ProviderNotFoundError } from "@winston/connectors/errors";
import type { MailProvider } from "@winston/connectors/mail";
import type { DbOrTx } from "@winston/db/client";
import { refsFor } from "@winston/db/external-refs";
import { auditLog, connections, events } from "@winston/db/schema";
import { parseEventPayload } from "@winston/domain/events";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";

type Connection = typeof connections.$inferSelect;
type NewEvent = typeof events.$inferInsert;

/** How far back a resync looks when Gmail's history has expired. */
export const resyncDays = 1;

/** How recent a write of Winston's must be to explain a label change. */
const selfCauseWindowMs = 15 * 60_000;

/** Gmail's category labels, as the catalog names them. */
const categories: Record<string, string> = {
  CATEGORY_PERSONAL: "primary",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_SOCIAL: "social",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
};

/** System labels worth reporting, by the names labels_changed uses. */
const flagLabels: Record<string, string> = {
  INBOX: "inbox",
  UNREAD: "unread",
  STARRED: "starred",
};

export interface MailSyncDeps {
  sync: ReturnType<typeof gmailSync>;
  mail: MailProvider;
}

/**
 * Syncs one mail connection. Returns the events it stored (new ones only),
 * for matching against subscriptions.
 */
export async function syncMail(
  db: DbOrTx,
  connection: Connection,
  deps: MailSyncDeps,
  now = new Date(),
) {
  const account = connection.externalEmail;
  const start = (connection.syncState as { historyId?: string } | null)
    ?.historyId;
  // The first sync only takes its place: earlier mail isn't news.
  if (!start) {
    await checkpoint(db, connection.id, await deps.sync.currentHistoryId());
    return [];
  }

  let added: HistoryMessage[] = [];
  const labelChanges: {
    record: string;
    message: HistoryMessage;
    added: string[];
    removed: string[];
  }[] = [];
  let historyId: string;
  try {
    const history = await deps.sync.history(start);
    historyId = history.historyId;
    for (const record of history.records) {
      added.push(...(record.messagesAdded ?? []).map((m) => m.message));
      for (const change of record.labelsAdded ?? [])
        labelChanges.push({
          record: record.id,
          message: change.message,
          added: change.labelIds,
          removed: [],
        });
      for (const change of record.labelsRemoved ?? [])
        labelChanges.push({
          record: record.id,
          message: change.message,
          added: [],
          removed: change.labelIds,
        });
    }
  } catch (error) {
    if (!(error instanceof HistoryExpiredError)) throw error;
    // Too old: catch up on the last day (dedupe drops repeats) and start over.
    historyId = await deps.sync.currentHistoryId();
    added = await deps.sync.recentMessages(resyncDays);
  }

  const found: NewEvent[] = [];
  const seen = new Set<string>();
  for (const message of added) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const event = await messageEvent(db, connection, deps, message, account);
    if (event) found.push(event);
  }

  const userLabelIds = labelChanges.some((change) =>
    [...change.added, ...change.removed].some((id) => isUserLabel(id)),
  );
  const names = userLabelIds
    ? await deps.sync.labelNames()
    : new Map<string, string>();
  const named = (ids: string[]) =>
    ids.flatMap((id) => {
      const name = flagLabels[id] ?? names.get(id);
      return name ? [name] : [];
    });
  for (const change of labelChanges) {
    const addedNames = named(change.added);
    const removedNames = named(change.removed);
    if (addedNames.length === 0 && removedNames.length === 0) continue;
    const ids = await cliIds(db, connection, change.message);
    found.push({
      userId: connection.userId,
      connectionId: connection.id,
      type: "mail.message.labels_changed",
      payload: {
        messageId: ids.messageId,
        threadId: ids.threadId,
        account,
        added: addedNames,
        removed: removedNames,
      },
      occurredAt: now,
      dedupeKey: `mail:${connection.id}:${change.message.id}:labels:${change.record}:${addedNames.length > 0 ? "+" : "-"}`,
      selfCaused: await labelsChangedByWinston(db, connection.id, ids, now),
    });
  }

  return store(db, connection.id, found, historyId);
}

/** The received or sent event for a new message, or undefined if it's neither (a draft, spam) or gone. */
async function messageEvent(
  db: DbOrTx,
  connection: Connection,
  deps: MailSyncDeps,
  message: HistoryMessage,
  account: string,
): Promise<NewEvent | undefined> {
  const labels = message.labelIds ?? [];
  const sent = labels.includes("SENT");
  if (!sent && !labels.includes("INBOX")) return undefined;
  let thread;
  try {
    thread = await deps.mail.getThread(message.threadId);
  } catch (error) {
    if (error instanceof ProviderNotFoundError) return undefined;
    throw error;
  }
  const index = thread.messages.findIndex((m) => m.providerId === message.id);
  const full = thread.messages[index];
  if (!full) return undefined;
  const ids = await cliIds(db, connection, message);
  const base = {
    messageId: ids.messageId,
    threadId: ids.threadId,
    account,
    from: full.from,
    to: full.to,
    cc: full.cc,
    subject: full.subject,
    snippet: full.snippet,
    date: full.date.toISOString(),
  };
  if (sent)
    return {
      userId: connection.userId,
      connectionId: connection.id,
      type: "mail.message.sent",
      payload: base,
      occurredAt: full.date,
      dedupeKey: `mail:${connection.id}:${message.id}:sent`,
      selfCaused: await sentByWinston(db, connection.id, message.id),
    };
  const previous = thread.messages[index - 1];
  return {
    userId: connection.userId,
    connectionId: connection.id,
    type: "mail.message.received",
    payload: {
      ...base,
      labels: full.labels,
      category:
        labels.map((id) => categories[id]).find((c) => c !== undefined) ?? null,
      unread: labels.includes("UNREAD"),
      hasAttachments: full.attachments.length > 0,
      isReplyToUser:
        previous?.from?.email.toLowerCase() === account.toLowerCase(),
    },
    occurredAt: full.date,
    dedupeKey: `mail:${connection.id}:${message.id}:received`,
    selfCaused: false,
  };
}

const isUserLabel = (id: string) => id.startsWith("Label_");

/** The CLI's ids for a message and its thread. */
async function cliIds(
  db: DbOrTx,
  connection: Connection,
  message: HistoryMessage,
) {
  const [messages, threads] = await Promise.all([
    refsFor(db, connection.userId, connection.id, "message", [message.id]),
    refsFor(db, connection.userId, connection.id, "thread", [message.threadId]),
  ]);
  return {
    messageId: messages.get(message.id) ?? "",
    threadId: threads.get(message.threadId) ?? "",
  };
}

/** Whether Winston sent this message himself (his audit row names it). */
async function sentByWinston(
  db: DbOrTx,
  connectionId: string,
  gmailId: string,
) {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.connectionId, connectionId),
        eq(auditLog.resultRef, gmailId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether Winston changed this message's labels just now (an update or delete naming it or its thread). */
async function labelsChangedByWinston(
  db: DbOrTx,
  connectionId: string,
  ids: { messageId: string; threadId: string },
  now: Date,
) {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.connectionId, connectionId),
        inArray(auditLog.action, ["mail.update", "mail.delete"]),
        gte(auditLog.createdAt, new Date(now.getTime() - selfCauseWindowMs)),
        or(
          sql`${auditLog.request}::text like ${`%"${ids.messageId}"%`}`,
          sql`${auditLog.request}::text like ${`%"${ids.threadId}"%`}`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function checkpoint(db: DbOrTx, connectionId: string, historyId: string) {
  await db
    .update(connections)
    .set({ syncState: { historyId } })
    .where(eq(connections.id, connectionId));
}

/**
 * Stores the events (each checked against the catalog, repeats dropped by
 * their dedupe key) and moves the checkpoint, together. Returns the events
 * that were new.
 */
async function store(
  db: DbOrTx,
  connectionId: string,
  found: NewEvent[],
  historyId: string,
) {
  return db.transaction(async (tx) => {
    const stored =
      found.length === 0
        ? []
        : await tx
            .insert(events)
            .values(
              found.map((event) => ({
                ...event,
                payload: parseEventPayload(event.type, event.payload),
              })),
            )
            .onConflictDoNothing({ target: events.dedupeKey })
            .returning();
    await checkpoint(tx, connectionId, historyId);
    return stored;
  });
}
