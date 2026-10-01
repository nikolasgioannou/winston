/**
 * The read side of `winston calendar` (docs/design.md §11): list and search,
 * get, free time, and the account's calendars. Every route resolves
 * `--account`, checks `read` on the server, and names events by `evt_` ids.
 * Times come back as instants (and all-day events as dates) with the user's
 * time zone, so the CLI shows them in it.
 */
import type { CalendarEvent, EventTime } from "@winston/connectors/calendar";
import {
  defaultWorkingHours,
  freeSlots,
  type WorkingHours,
} from "@winston/connectors/free-slots";
import { isExternal } from "@winston/connectors/google-calendar";
import type { DbOrTx } from "@winston/db/client";
import { refsFor, resolveRef } from "@winston/db/external-refs";
import { connections, users } from "@winston/db/schema";
import { parseHumanTime } from "@winston/shared/human-time";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import {
  ApiFailure,
  requireCapability,
  resolveConnection,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const flag = z.enum(["true", "false"]).transform((v) => v === "true");

const listQuery = z.object({
  account: z.string().optional(),
  calendar: z.string().optional(),
  text: z.string().optional(),
  attendee: z.string().optional(),
  organizer: z.string().optional(),
  external: flag.optional(),
  title: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const freeQuery = z.object({
  account: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  duration: z.coerce
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .default(30),
  attendee: z.union([z.string(), z.array(z.string())]).optional(),
  /** Working hours as `9-18` or `9:30-17:30`. */
  hours: z
    .string()
    .regex(/^\d{1,2}(:\d{2})?-\d{1,2}(:\d{2})?$/)
    .optional(),
  weekends: flag.optional(),
});

/** An event as the API returns it: CLI ids, instants as ISO strings. */
export interface EventDto {
  id: string;
  seriesId: string | null;
  calendar: string;
  title: string;
  start: { at: string } | { date: string };
  end: { at: string } | { date: string };
  allDay: boolean;
  location: string | null;
  description: string | null;
  organizer: CalendarEvent["organizer"];
  attendees: CalendarEvent["attendees"];
  myResponse: CalendarEvent["myResponse"];
  status: CalendarEvent["status"];
  videoLink: string | null;
  recurrence: string[] | null;
  external: boolean;
}

const timeDto = (time: EventTime) =>
  "at" in time ? { at: time.at.toISOString() } : { date: time.date };

/** Minutes after midnight from `9` or `9:30`. */
const minuteOf = (text: string) => {
  const [hours = "0", minutes = "0"] = text.split(":");
  return Number(hours) * 60 + Number(minutes);
};

export function calendarRoutes({
  db,
  connectors,
}: {
  db: DbOrTx;
  connectors: ConnectorDeps | undefined;
}) {
  const need = () => {
    const calendar = connectors?.calendar;
    if (!connectors || !calendar)
      throw new ApiFailure("unavailable", "Calendars aren't available here.");
    return { webPublicUrl: connectors.webPublicUrl, calendar };
  };

  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** Resolves a time flag in the user's zone; bare durations look ahead. */
  const resolveTime = (
    input: string | undefined,
    timeZone: string,
    fallback: Date,
  ) =>
    input === undefined
      ? fallback
      : parseHumanTime(input, { timeZone, direction: "future" });

  /** CLI ids for events and their series, and the DTOs. */
  async function dtos(
    userId: string,
    connection: ConnectionRow,
    events: CalendarEvent[],
  ) {
    const ids = await refsFor(db, userId, connection.id, "calendarEvent", [
      ...events.map((e) => e.providerId),
      ...events.flatMap((e) => (e.seriesId ? [e.seriesId] : [])),
    ]);
    return events.map((e): EventDto => ({
      id: ids.get(e.providerId) ?? "",
      seriesId: e.seriesId ? (ids.get(e.seriesId) ?? null) : null,
      calendar: e.calendarId,
      title: e.title,
      start: timeDto(e.start),
      end: timeDto(e.end),
      allDay: e.allDay,
      location: e.location,
      description: e.description,
      organizer: e.organizer,
      attendees: e.attendees,
      myResponse: e.myResponse,
      status: e.status,
      videoLink: e.videoLink,
      recurrence: e.recurrence,
      external: isExternal(e, connection.externalEmail),
    }));
  }

  async function connectionFor(userId: string, account: string | undefined) {
    const deps = need();
    const connection = await resolveConnection(db, userId, "calendar", account);
    requireCapability(connection, "read", deps.webPublicUrl);
    return { connection, provider: deps.calendar(connection) };
  }

  return new Hono<VmApiEnv>()
    .get("/events", async (c) => {
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success)
        throw new ApiFailure(
          "invalid_request",
          z.prettifyError(parsed.error),
          "Run winston calendar list --help for the flags.",
        );
      const query = parsed.data;
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const timeZone = await timeZoneOf(userId);
      const now = new Date();
      const since = resolveTime(query.since, timeZone, now);
      const until = resolveTime(
        query.until,
        timeZone,
        new Date(since.getTime() + 7 * 24 * 3600_000),
      );
      if (until <= since)
        throw new ApiFailure(
          "invalid_request",
          "--until must be after --since.",
        );
      const page = await provider.list(
        {
          calendarId: query.calendar,
          text: query.text,
          attendee: query.attendee,
          organizer: query.organizer,
          external: query.external,
          title: query.title,
          since,
          until,
        },
        { limit: query.limit, cursor: query.cursor },
      );
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        timeZone,
        range: { since: since.toISOString(), until: until.toISOString() },
        events: await dtos(userId, connection, page.items),
        cursor: page.cursor,
      });
    })
    .get("/events/:id", async (c) => {
      const { userId } = c.get("run");
      const id = c.req.param("id");
      const ref = await resolveRef(db, userId, id);
      if (ref?.kind !== "calendarEvent")
        throw new ApiFailure(
          "not_found",
          `There's no ${id}.`,
          "Use an id from winston calendar list or search.",
        );
      const [connection] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, ref.connectionId),
            eq(connections.userId, userId),
          ),
        );
      if (!connection) throw new ApiFailure("not_found", `There's no ${id}.`);
      const deps = need();
      requireCapability(connection, "read", deps.webPublicUrl);
      const event = await deps.calendar(connection).get(ref.providerId);
      const [dto] = await dtos(userId, connection, [event]);
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        timeZone: await timeZoneOf(userId),
        event: dto,
      });
    })
    .get("/free", async (c) => {
      const parsed = freeQuery.safeParse({
        ...c.req.query(),
        attendee: c.req.queries("attendee"),
      });
      if (!parsed.success)
        throw new ApiFailure(
          "invalid_request",
          z.prettifyError(parsed.error),
          "Run winston calendar free --help for the flags.",
        );
      const query = parsed.data;
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        query.account,
      );
      const timeZone = await timeZoneOf(userId);
      const since = resolveTime(query.since, timeZone, new Date());
      const until = resolveTime(
        query.until,
        timeZone,
        new Date(since.getTime() + 7 * 24 * 3600_000),
      );
      const attendees = [query.attendee ?? []]
        .flat()
        .map((a) => a.toLowerCase());
      const busy = await provider.freeBusy({ since, until, attendees });
      const known = [...busy.values()].flatMap((b) =>
        b === "unknown" ? [] : b,
      );
      const hours: WorkingHours = query.hours
        ? {
            startMinute: minuteOf(query.hours.split("-")[0] ?? "9"),
            endMinute: minuteOf(query.hours.split("-")[1] ?? "18"),
            days: query.weekends
              ? [1, 2, 3, 4, 5, 6, 7]
              : defaultWorkingHours.days,
          }
        : {
            ...defaultWorkingHours,
            ...(query.weekends ? { days: [1, 2, 3, 4, 5, 6, 7] } : {}),
          };
      if (hours.endMinute <= hours.startMinute)
        throw new ApiFailure(
          "invalid_request",
          "--hours must end after it starts, like 9-18.",
        );
      const slots = freeSlots({
        busy: known,
        since,
        until,
        durationMinutes: query.duration,
        timeZone,
        hours,
      });
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        timeZone,
        range: { since: since.toISOString(), until: until.toISOString() },
        duration: query.duration,
        hours: {
          start: hours.startMinute,
          end: hours.endMinute,
          weekends: hours.days.length === 7,
        },
        /** Whose busy time was taken into account, and whose couldn't be seen. */
        considered: [...busy.entries()].map(([who, blocks]) => ({
          who,
          visible: blocks !== "unknown",
        })),
        slots: slots.map((s) => ({
          start: s.start.toISOString(),
          end: s.end.toISOString(),
        })),
      });
    })
    .get("/calendars", async (c) => {
      const { userId } = c.get("run");
      const { connection, provider } = await connectionFor(
        userId,
        c.req.query("account"),
      );
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        calendars: await provider.listCalendars(),
      });
    });
}
