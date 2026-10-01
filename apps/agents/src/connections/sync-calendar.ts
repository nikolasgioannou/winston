/**
 * Calendar sync (docs/design.md §3 calendar events, §17 event pipeline): each
 * watched calendar's changes since its sync token, diffed against the last
 * seen state of each event (`calendar_event_snapshots`), become catalog
 * events. Series come as one event, so a change to the whole series is one
 * change; a moved or cancelled instance is described from its series.
 */
import {
  isExternal,
  toCalendarEvent,
  type GoogleEvent,
} from "@winston/connectors/google-calendar";
import {
  SyncTokenExpiredError,
  type googleCalendarSync,
} from "@winston/connectors/google-calendar-sync";
import type { CalendarEvent, EventTime } from "@winston/connectors/calendar";
import type { DbOrTx } from "@winston/db/client";
import { refsFor } from "@winston/db/external-refs";
import {
  auditLog,
  calendarEventSnapshots,
  connections,
  events,
} from "@winston/db/schema";
import { parseEventPayload } from "@winston/domain/events";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

type Connection = typeof connections.$inferSelect;
type NewEvent = typeof events.$inferInsert;

/** How far back a first (or full) sync starts: events ending after this are tracked. */
export const windowMs = 24 * 3600_000;

/** How recent a write of Winston's must be to explain a change. */
const selfCauseWindowMs = 15 * 60_000;

/** What's remembered of an event, and what changes are noticed in. */
export interface Snapshot {
  calendar: string;
  title: string;
  start: { at: string } | { date: string };
  end: { at: string } | { date: string };
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: { email: string; name: string | null; self: boolean } | null;
  attendees: {
    email: string;
    name: string | null;
    response: "needs_action" | "accepted" | "declined" | "tentative";
    self: boolean;
  }[];
  external: boolean;
  videoLink: string | null;
}

/** Fields a change to one shows up in, in `calendar.event.updated`'s list. */
const diffed = [
  "title",
  "start",
  "end",
  "location",
  "description",
  "videoLink",
] as const;

type SyncState = Record<string, unknown> & {
  calendars?: Record<string, { syncToken: string; since: string }>;
};

export interface CalendarSyncDeps {
  sync: ReturnType<typeof googleCalendarSync>;
}

const time = (t: EventTime) =>
  "at" in t ? { at: t.at.toISOString() } : { date: t.date };

function snapshotOf(event: CalendarEvent, account: string): Snapshot {
  return {
    calendar: event.calendarId,
    title: event.title,
    start: time(event.start),
    end: time(event.end),
    allDay: event.allDay,
    location: event.location,
    description: event.description,
    organizer: event.organizer,
    attendees: event.attendees.map((a) => ({
      email: a.email,
      name: a.name,
      response: a.response,
      self: a.self,
    })),
    external: isExternal(event, account),
    videoLink: event.videoLink,
  };
}

/** A series' snapshot moved to one instance's original time. */
function asInstance(
  series: Snapshot,
  original: GoogleEvent["originalStartTime"],
) {
  if (!original) return series;
  if (original.date)
    return {
      ...series,
      start: { date: original.date },
      end: { date: original.date },
    };
  const start = new Date(original.dateTime ?? 0);
  const length =
    "at" in series.start && "at" in series.end
      ? new Date(series.end.at).getTime() - new Date(series.start.at).getTime()
      : 0;
  return {
    ...series,
    start: { at: start.toISOString() },
    end: { at: new Date(start.getTime() + length).toISOString() },
  };
}

/** A provider event in the catalog's shape, with the CLI's id. */
export const catalogEvent = (
  event: CalendarEvent,
  eventId: string,
  account: string,
) => payloadEvent(snapshotOf(event, account), eventId, account);

/** The catalog's event shape, with the CLI's id. */
const payloadEvent = (s: Snapshot, eventId: string, account: string) => ({
  eventId,
  account,
  calendar: s.calendar,
  title: s.title,
  start: s.start,
  end: s.end,
  allDay: s.allDay,
  location: s.location,
  organizer: s.organizer,
  attendees: s.attendees.map(({ email, name, response }) => ({
    email,
    name,
    response,
  })),
  external: s.external,
  videoLink: s.videoLink,
});

/**
 * Syncs one calendar connection. Returns the events it stored (new ones
 * only), for matching against subscriptions and following timers.
 */
export async function syncCalendar(
  db: DbOrTx,
  connection: Connection,
  deps: CalendarSyncDeps,
  now = new Date(),
) {
  const account = connection.externalEmail;
  const state = (connection.syncState ?? {}) as SyncState;
  const calendars = await deps.sync.watchedCalendars();
  const tokens: NonNullable<SyncState["calendars"]> = {};
  const found: NewEvent[] = [];
  const snapshotWrites = new Map<string, Snapshot | null>();

  const known = new Map(
    (
      await db
        .select()
        .from(calendarEventSnapshots)
        .where(eq(calendarEventSnapshots.connectionId, connection.id))
    ).map((row) => [row.providerId, row.snapshot as Snapshot]),
  );
  const snapshot = (providerId: string) =>
    snapshotWrites.has(providerId)
      ? (snapshotWrites.get(providerId) ?? undefined)
      : known.get(providerId);

  for (const calendarId of calendars) {
    const stored = state.calendars?.[calendarId];
    const since = new Date(now.getTime() - windowMs);
    let changed: GoogleEvent[];
    let first = false;
    try {
      const result = await deps.sync.changes(
        calendarId,
        stored ? { syncToken: stored.syncToken } : { since },
      );
      changed = result.events;
      first = !stored;
      tokens[calendarId] = {
        syncToken: result.nextSyncToken,
        since: stored?.since ?? since.toISOString(),
      };
    } catch (error) {
      if (!(error instanceof SyncTokenExpiredError)) throw error;
      // The token's gone: list the window again and diff it against what's known.
      const result = await deps.sync.changes(calendarId, { since });
      changed = result.events;
      tokens[calendarId] = {
        syncToken: result.nextSyncToken,
        since: since.toISOString(),
      };
    }

    for (const raw of changed) {
      const event = toCalendarEvent(calendarId, raw, account);
      const providerId = event.providerId;
      const before = snapshot(providerId);
      const seriesBefore = event.seriesId
        ? snapshot(event.seriesId)
        : undefined;
      // The first sync only takes its place.
      if (first) {
        if (event.status !== "cancelled")
          snapshotWrites.set(providerId, snapshotOf(event, account));
        continue;
      }
      const [eventId = ""] = [
        (
          await refsFor(db, connection.userId, connection.id, "calendarEvent", [
            providerId,
          ])
        ).get(providerId),
      ];
      const key = `cal:${connection.id}:${providerId}`;
      const stamp = raw.updated ?? now.toISOString();
      const occurredAt = raw.updated ? new Date(raw.updated) : now;
      const add = (
        type: string,
        payload: unknown,
        suffix: string,
        selfCaused: boolean,
      ) =>
        found.push({
          userId: connection.userId,
          connectionId: connection.id,
          type,
          payload,
          occurredAt,
          dedupeKey: `${key}:${suffix}:${stamp}`,
          selfCaused,
        });

      if (event.status === "cancelled") {
        const was =
          before ??
          (seriesBefore
            ? asInstance(seriesBefore, raw.originalStartTime)
            : undefined);
        if (was)
          add(
            "calendar.event.cancelled",
            { event: payloadEvent(was, eventId, account) },
            "cancelled",
            await changedByWinston(
              db,
              connection.id,
              eventId,
              ["calendar.delete"],
              now,
            ),
          );
        snapshotWrites.set(providerId, null);
        continue;
      }

      const after = snapshotOf(event, account);
      snapshotWrites.set(providerId, after);
      const baseline =
        before ??
        (seriesBefore
          ? asInstance(seriesBefore, raw.originalStartTime)
          : undefined);
      if (!baseline) {
        // An old event changed before we had seen it: nothing to compare with.
        if (
          raw.created &&
          new Date(raw.created) < new Date(tokens[calendarId].since)
        )
          continue;
        const invited =
          event.organizer !== null &&
          !event.organizer.self &&
          event.attendees.some((a) => a.self);
        if (invited)
          add(
            "calendar.invitation.received",
            { event: payloadEvent(after, eventId, account) },
            "invitation",
            false,
          );
        else
          add(
            "calendar.event.created",
            { event: payloadEvent(after, eventId, account) },
            "created",
            await createdByWinston(db, connection.id, providerId),
          );
        continue;
      }

      const changes: { field: string; before: unknown; after: unknown }[] =
        diffed
          .filter(
            (field) =>
              JSON.stringify(baseline[field]) !== JSON.stringify(after[field]),
          )
          .map((field) => ({
            field,
            before: baseline[field],
            after: after[field],
          }));
      const emails = (s: Snapshot) => s.attendees.map((a) => a.email).sort();
      if (JSON.stringify(emails(baseline)) !== JSON.stringify(emails(after)))
        changes.push({
          field: "attendees",
          before: emails(baseline),
          after: emails(after),
        });
      if (changes.length > 0)
        add(
          "calendar.event.updated",
          { event: payloadEvent(after, eventId, account), changes },
          "updated",
          await changedByWinston(
            db,
            connection.id,
            eventId,
            ["calendar.update"],
            now,
          ),
        );

      // Answers to the user's own events, other than the user's own.
      if (after.organizer?.self)
        for (const attendee of after.attendees) {
          if (attendee.self) continue;
          const previous = baseline.attendees.find(
            (a) => a.email === attendee.email,
          );
          if (previous?.response === attendee.response) continue;
          if (!previous && attendee.response === "needs_action") continue;
          add(
            "calendar.rsvp.changed",
            {
              event: payloadEvent(after, eventId, account),
              attendee: { email: attendee.email, name: attendee.name },
              response: attendee.response,
            },
            `rsvp:${attendee.email}`,
            false,
          );
        }
    }
  }

  return store(db, connection, found, snapshotWrites, {
    ...state,
    calendars: tokens,
  });
}

/** Whether Winston made this event himself (his audit row names it). */
async function createdByWinston(
  db: DbOrTx,
  connectionId: string,
  providerId: string,
) {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.connectionId, connectionId),
        eq(auditLog.action, "calendar.create"),
        eq(auditLog.resultRef, providerId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Whether Winston just changed or deleted this event. */
async function changedByWinston(
  db: DbOrTx,
  connectionId: string,
  eventId: string,
  actions: string[],
  now: Date,
) {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.connectionId, connectionId),
        inArray(auditLog.action, actions),
        eq(auditLog.targetRef, eventId),
        gte(auditLog.createdAt, new Date(now.getTime() - selfCauseWindowMs)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Stores the events (checked against the catalog, repeats dropped), the
 * snapshots and the new sync tokens, together. Returns the new events.
 */
async function store(
  db: DbOrTx,
  connection: Connection,
  found: NewEvent[],
  snapshots: Map<string, Snapshot | null>,
  state: SyncState,
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
    for (const [providerId, snapshot] of snapshots) {
      const row = and(
        eq(calendarEventSnapshots.connectionId, connection.id),
        eq(calendarEventSnapshots.providerId, providerId),
      );
      if (snapshot === null) await tx.delete(calendarEventSnapshots).where(row);
      else
        await tx
          .insert(calendarEventSnapshots)
          .values({ connectionId: connection.id, providerId, snapshot })
          .onConflictDoUpdate({
            target: [
              calendarEventSnapshots.connectionId,
              calendarEventSnapshots.providerId,
            ],
            set: { snapshot, updatedAt: sql`now()` },
          });
    }
    await tx
      .update(connections)
      .set({ syncState: state })
      .where(eq(connections.id, connection.id));
    return stored;
  });
}
