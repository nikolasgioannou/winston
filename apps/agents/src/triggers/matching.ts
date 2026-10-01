/**
 * Matching events to subscriptions (docs/design.md §3, §17 event pipeline
 * steps 5–7): each new event is checked against the user's active
 * subscriptions for its type (account, scope, structured filter, then the
 * provider-native query, which costs a call), and a match joins the
 * subscription's pending batch. A batch fires 30 s after its first event, as
 * one background run with every event in it.
 *
 * Events Winston caused himself (`self_caused`) fire nothing: that's what
 * keeps him from reacting to his own actions.
 */
import type { MailProvider } from "@winston/connectors/mail";
import type { DbOrTx } from "@winston/db/client";
import { resolveRef } from "@winston/db/external-refs";
import { enqueue } from "@winston/db/queue";
import { events, triggerBatches, triggers } from "@winston/db/schema";
import { fireTriggerBatchJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { startTriggerRun } from "../background/trigger-run.ts";
import type { JobHandler } from "../worker.ts";

/** How long a batch collects events after its first one. */
export const batchWindowMs = 30_000;

type StoredEvent = typeof events.$inferSelect;
type Trigger = typeof triggers.$inferSelect;
type Person = { email: string; name: string | null } | null;

/** Checks a provider-native query against one event's message (Gmail search syntax). */
export type NativeQueryCheck = (
  connectionId: string,
  query: string,
  messageId: string,
) => Promise<boolean>;

const contains = (haystack: string | null | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
const personMatches = (person: Person, needle: string) =>
  person !== null &&
  (contains(person.email, needle) || contains(person.name, needle));

/**
 * Whether an event's payload passes a structured filter, field by field,
 * with the catalog's meanings (the same as the CLI's search flags).
 */
export function passesFilter(
  payload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  const event = (payload.event ?? {}) as {
    calendar?: string;
    title?: string;
    organizer?: Person;
    attendees?: Person[];
    external?: boolean;
  };
  const labels = [
    ...((payload.labels as string[] | undefined) ?? []),
    ...((payload.added as string[] | undefined) ?? []),
  ];
  return Object.entries(filter).every(([name, value]) => {
    const text = String(value);
    switch (name) {
      case "from":
        return personMatches((payload.from ?? null) as Person, text);
      case "to":
        return [
          ...((payload.to as Person[] | undefined) ?? []),
          ...((payload.cc as Person[] | undefined) ?? []),
        ].some((p) => personMatches(p, text));
      case "subject":
        return contains(payload.subject as string | undefined, text);
      case "unread":
        return payload.unread === true;
      case "has-attachment":
        return payload.hasAttachments === true;
      case "label":
        return labels.some((l) => l.toLowerCase() === text.toLowerCase());
      case "category":
        return payload.category === text.toLowerCase();
      case "is-reply-to-user":
        return payload.isReplyToUser === true;
      case "calendar":
        return contains(event.calendar, text);
      case "attendee":
        return (event.attendees ?? []).some((p) => personMatches(p, text));
      case "organizer":
        return personMatches(event.organizer ?? null, text);
      case "external":
        return event.external === true;
      case "title":
        return contains(event.title, text);
      case "min-attendees":
        return (event.attendees ?? []).length >= Number(value);
      default:
        // A field the catalog doesn't know never matches, rather than everything.
        return false;
    }
  });
}

/** The object a scoped subscription watches: a mail event's thread, or a calendar event's id. */
const scopeOf = (payload: Record<string, unknown>) =>
  (payload.threadId as string | undefined) ??
  (payload.event as { eventId?: string } | undefined)?.eventId ??
  undefined;

/** Whether a subscription wants this event, the native query (an API call) last. */
async function wants(
  db: DbOrTx,
  trigger: Trigger,
  event: StoredEvent,
  native: NativeQueryCheck | undefined,
) {
  if (trigger.connectionId && trigger.connectionId !== event.connectionId)
    return false;
  const payload = event.payload as Record<string, unknown>;
  if (trigger.scopeRef && scopeOf(payload) !== trigger.scopeRef) return false;
  if (!passesFilter(payload, trigger.filter as Record<string, unknown>))
    return false;
  if (trigger.nativeQuery) {
    const messageId = payload.messageId as string | undefined;
    if (!native || !messageId || !event.connectionId) return false;
    const ref = await resolveRef(db, event.userId, messageId);
    if (!ref) return false;
    return native(event.connectionId, trigger.nativeQuery, ref.providerId);
  }
  return true;
}

/**
 * Matches new events to subscriptions and adds each match to its
 * subscription's pending batch. Returns how many matches there were.
 */
export async function matchEvents(
  db: DbOrTx,
  stored: readonly StoredEvent[],
  options: { native?: NativeQueryCheck; logger?: Logger } = {},
) {
  let matched = 0;
  for (const event of stored) {
    if (event.selfCaused) continue;
    const candidates = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.userId, event.userId),
          eq(triggers.kind, "subscription"),
          eq(triggers.status, "active"),
          eq(triggers.eventType, event.type),
        ),
      );
    for (const trigger of candidates) {
      let match: boolean;
      try {
        match = await wants(db, trigger, event, options.native);
      } catch (error) {
        options.logger?.warn(
          { err: error, triggerId: trigger.id, eventId: event.id },
          "checking a subscription's native query failed; skipping it",
        );
        continue;
      }
      if (!match) continue;
      await addToBatch(db, trigger, event.id);
      matched += 1;
    }
  }
  return matched;
}

/**
 * Adds an event to the trigger's pending batch, starting one (and its firing
 * job, due in 30 s) if there's none. One statement, so concurrent matches
 * land in the same batch.
 */
export async function addToBatch(
  db: DbOrTx,
  trigger: Pick<Trigger, "id" | "userId">,
  eventId: string,
) {
  const [batch] = await db
    .insert(triggerBatches)
    .values({
      triggerId: trigger.id,
      eventIds: [eventId],
      fireAt: sql`now() + ${batchWindowMs} * interval '1 millisecond'`,
    })
    .onConflictDoUpdate({
      target: triggerBatches.triggerId,
      targetWhere: sql`status = 'pending'`,
      set: {
        eventIds: sql`case when ${eventId} = any(${triggerBatches.eventIds}) then ${triggerBatches.eventIds} else array_append(${triggerBatches.eventIds}, ${eventId}) end`,
      },
    })
    .returning({ id: triggerBatches.id, started: sql<boolean>`xmax = 0` });
  if (!batch?.started) return;
  await enqueue(db, fireTriggerBatchJob.type, {
    userId: trigger.userId,
    payload: { batchId: batch.id },
    dedupeKey: fireTriggerBatchJob.dedupeKey(batch.id),
    delayMs: batchWindowMs,
  });
}

/**
 * Fires a batch: one trigger run with all its events, oldest first. The
 * batch is locked meanwhile and marked fired with its run, so it fires once.
 * A trigger that can't fire any more (exhausted or expired since) just closes
 * the batch.
 */
export async function fireBatch(db: DbOrTx, batchId: number) {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(triggerBatches)
      .where(eq(triggerBatches.id, batchId))
      .for("update");
    if (batch?.status !== "pending") return undefined;
    const rows = batch.eventIds.length
      ? await tx
          .select()
          .from(events)
          .where(inArray(events.id, batch.eventIds))
          .orderBy(asc(events.occurredAt), asc(events.id))
      : [];
    const runId = await startTriggerRun(tx, {
      triggerId: batch.triggerId,
      reason: "event",
      events: rows.map((row) => ({
        type: row.type,
        occurredAt: row.occurredAt,
        data: row.payload,
      })),
    });
    await tx
      .update(triggerBatches)
      .set({ status: "fired", runId: runId ?? null })
      .where(eq(triggerBatches.id, batchId));
    return runId;
  });
}

/** `match_events`: matches events stored elsewhere (system events from the site). */
export const matchEventsHandler: JobHandler = async ({ job, db, logger }) => {
  const { eventIds } = z
    .object({ eventIds: z.array(z.string()) })
    .parse(job.payload);
  const rows = await db
    .select()
    .from(events)
    .where(inArray(events.id, eventIds));
  const matched = await matchEvents(db, rows, { logger });
  logger.info({ events: rows.length, matched }, "matched events");
};

/** `fire_trigger_batch`: fires a batch at its time. */
export const fireTriggerBatchHandler: JobHandler = async ({
  job,
  db,
  logger,
}) => {
  const { batchId } = z.object({ batchId: z.number() }).parse(job.payload);
  const runId = await fireBatch(db, batchId);
  logger.info(
    { batchId, runId },
    runId ? "batch fired" : "batch closed without a run",
  );
};

/**
 * The Gmail native-query check: the message's Message-ID, then a search for
 * `<query> rfc822msgid:<id>`, so Gmail's own query language decides
 * (docs/design.md §3, mail filter).
 */
export function gmailNativeCheck(
  mailFor: (connectionId: string) => Promise<MailProvider>,
): NativeQueryCheck {
  return async (connectionId, query, messageId) => {
    const mail = await mailFor(connectionId);
    const message = await mail.getMessage(messageId);
    if (!message.messageIdHeader) return false;
    const page = await mail.list(
      {
        folder: "all",
        native: `${query} rfc822msgid:${message.messageIdHeader}`,
      },
      { limit: 5 },
    );
    return page.items.some((item) => item.providerId === messageId);
  };
}
