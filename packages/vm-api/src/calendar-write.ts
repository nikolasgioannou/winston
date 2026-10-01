/**
 * The write side of `winston calendar` (docs/design.md §11, §5): create,
 * update, delete and RSVP, each behind its capability (`create`, `update`,
 * `delete`, `rsvp`) and on the audit log. Times arrive as the CLI's raw
 * strings and are resolved here in the user's zone. Attendees are notified
 * by default when there are any (other than the user), since changing a
 * shared meeting emails people; `notify` overrides it. `dryRun` returns the
 * resulting event and who would be emailed, after the same checks.
 */
import type {
  CalendarEvent,
  EventChanges,
  EventTime,
  NewEvent,
} from "@winston/connectors/calendar";
import { startInstant } from "@winston/connectors/google-calendar";
import { audited } from "@winston/db/audit";
import type { DbOrTx } from "@winston/db/client";
import { refFor, resolveRef } from "@winston/db/external-refs";
import { connections, users } from "@winston/db/schema";
import { parseHumanTime } from "@winston/shared/human-time";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  ApiFailure,
  requireCapability,
  resolveConnection,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";

const email = z.string().min(3);
const scope = z.enum(["this", "following", "all"]).default("this");

const createBody = z.object({
  account: z.string().optional(),
  calendar: z.string().optional(),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().optional(),
  duration: z
    .number()
    .int()
    .min(1)
    .max(14 * 24 * 60)
    .optional(),
  allDay: z.boolean().default(false),
  attendees: z.array(email).max(100).default([]),
  location: z.string().optional(),
  description: z.string().optional(),
  video: z.boolean().default(false),
  repeat: z.string().optional(),
  notify: z.boolean().optional(),
  dryRun: z.boolean().default(false),
});

const updateBody = z.object({
  title: z.string().min(1).optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  duration: z
    .number()
    .int()
    .min(1)
    .max(14 * 24 * 60)
    .optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  video: z.boolean().optional(),
  repeat: z.string().optional(),
  addAttendees: z.array(email).max(100).default([]),
  removeAttendees: z.array(email).max(100).default([]),
  scope,
  notify: z.boolean().optional(),
  dryRun: z.boolean().default(false),
});

const deleteBody = z.object({
  scope,
  notify: z.boolean().optional(),
  dryRun: z.boolean().default(false),
});

const rsvpBody = z.object({
  response: z.enum(["accepted", "declined", "tentative"]),
  note: z.string().optional(),
  scope: z.enum(["this", "all"]).default("this"),
  dryRun: z.boolean().default(false),
});

const body = <T extends z.ZodType>(schema: T, hint: string) =>
  validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiFailure(
        "invalid_request",
        z.prettifyError(parsed.error),
        hint,
      );
    return parsed.data;
  });

/** RRULE lines from `--repeat`: one rule, with or without its `RRULE:` prefix. */
const rules = (repeat: string | undefined) => {
  if (repeat === undefined) return undefined;
  const rule = repeat.trim().replace(/^RRULE:/i, "");
  if (!/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[^;]+)*$/i.test(rule))
    throw new ApiFailure(
      "invalid_request",
      `"${repeat}" isn't an RRULE.`,
      'For example --repeat "FREQ=WEEKLY;BYDAY=TU".',
    );
  return [`RRULE:${rule.toUpperCase()}`];
};

/** The calendar date of an instant in `timeZone`, as `YYYY-MM-DD`. */
const dateIn = (date: Date, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();

const plusDays = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/** Who'd get an email: everyone on it but the user. */
const notified = (attendees: string[], self: string) =>
  attendees.filter((a) => a.toLowerCase() !== self.toLowerCase());

const timeDto = (time: EventTime) =>
  "at" in time ? { at: time.at.toISOString() } : { date: time.date };

export function calendarWriteRoutes({
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

  const when = (input: string, timeZone: string) =>
    parseHumanTime(input, { timeZone, direction: "future" });

  /** An event by its evt_ id, with its connection checked for `capability`. */
  async function eventFor(
    userId: string,
    id: string,
    capability: "update" | "delete" | "rsvp",
  ) {
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
    requireCapability(connection, capability, deps.webPublicUrl);
    const provider = deps.calendar(connection);
    return {
      ref,
      connection,
      provider,
      event: await provider.get(ref.providerId),
    };
  }

  /** The event as the API returns it, with its new or kept evt_ id. */
  async function dto(
    userId: string,
    connection: ConnectionRow,
    event: CalendarEvent,
  ) {
    return {
      id: await refFor(
        db,
        userId,
        connection.id,
        "calendarEvent",
        event.providerId,
      ),
      title: event.title,
      start: timeDto(event.start),
      end: timeDto(event.end),
      allDay: event.allDay,
      location: event.location,
      attendees: event.attendees.map((a) => ({
        email: a.email,
        response: a.response,
      })),
      videoLink: event.videoLink,
      recurrence: event.recurrence,
    };
  }

  const account = (connection: ConnectionRow) => ({
    id: connection.id,
    email: connection.externalEmail,
  });

  return new Hono<VmApiEnv>()
    .post(
      "/events",
      body(createBody, "Run winston calendar create --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const ends = [
          input.end !== undefined,
          input.duration !== undefined,
          input.allDay,
        ].filter(Boolean).length;
        if (ends !== 1)
          throw new ApiFailure(
            "invalid_request",
            "Say how long: exactly one of --end, --duration or --all-day.",
          );
        const deps = need();
        const connection = await resolveConnection(
          db,
          userId,
          "calendar",
          input.account,
        );
        requireCapability(connection, "create", deps.webPublicUrl);
        const provider = deps.calendar(connection);
        const timeZone = await timeZoneOf(userId);
        const startAt = when(input.start, timeZone);
        let start: EventTime;
        let end: EventTime;
        if (input.allDay) {
          start = { date: dateIn(startAt, timeZone) };
          end = { date: plusDays(start.date, 1) };
        } else {
          start = { at: startAt };
          end = {
            at: input.end
              ? when(input.end, timeZone)
              : new Date(startAt.getTime() + (input.duration ?? 0) * 60_000),
          };
          if (end.at <= start.at)
            throw new ApiFailure(
              "invalid_request",
              "The event must end after it starts.",
            );
        }
        let calendarId: string | undefined;
        if (input.calendar) {
          const wanted = input.calendar.toLowerCase();
          const match = (await provider.listCalendars()).find(
            (cal) =>
              cal.writable &&
              (cal.id.toLowerCase() === wanted ||
                cal.name.toLowerCase() === wanted),
          );
          if (!match)
            throw new ApiFailure(
              "not_found",
              `No calendar you can add to is called ${input.calendar}.`,
              "winston accounts get <email> lists the calendars.",
            );
          calendarId = match.id;
        }
        const event: NewEvent = {
          calendarId,
          title: input.title,
          start,
          end,
          attendees: input.attendees,
          location: input.location,
          description: input.description,
          video: input.video,
          recurrence: rules(input.repeat),
          timeZone,
        };
        const notify =
          input.notify ??
          notified(input.attendees, connection.externalEmail).length > 0;
        const notifies = notify
          ? notified(input.attendees, connection.externalEmail)
          : [];
        if (input.dryRun)
          return c.json({
            account: account(connection),
            timeZone,
            dryRun: true as const,
            notifies,
            event: {
              title: event.title,
              start: timeDto(start),
              end: timeDto(end),
              allDay: input.allDay,
              calendar: calendarId ?? "primary",
              attendees: input.attendees,
              location: input.location ?? null,
              video: input.video,
              recurrence: event.recurrence ?? null,
            },
          });
        const created = await audited(
          db,
          {
            userId,
            runId,
            connectionId: connection.id,
            action: "calendar.create",
            summary: `Created "${input.title}"${notifies.length ? `, inviting ${notifies.join(", ")}` : ""}`,
            request: { ...input, dryRun: undefined },
          },
          () => provider.create(event, { notify }),
          (made) => made.providerId,
        );
        return c.json({
          account: account(connection),
          timeZone,
          dryRun: false as const,
          notifies,
          event: await dto(userId, connection, created),
        });
      },
    )
    .patch(
      "/events/:id",
      body(updateBody, "Run winston calendar update --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        if (input.end !== undefined && input.duration !== undefined)
          throw new ApiFailure(
            "invalid_request",
            "Pass --end or --duration, not both.",
          );
        const { ref, connection, provider, event } = await eventFor(
          userId,
          id,
          "update",
        );
        const timeZone = await timeZoneOf(userId);
        const changes: EventChanges = {
          title: input.title,
          location: input.location,
          description: input.description,
          video: input.video,
          recurrence: rules(input.repeat),
          addAttendees: input.addAttendees,
          removeAttendees: input.removeAttendees,
          timeZone,
        };
        // Moving the start keeps the length unless an end or duration says otherwise.
        if (
          input.start !== undefined ||
          input.end !== undefined ||
          input.duration !== undefined
        ) {
          if (event.allDay)
            throw new ApiFailure(
              "not_supported",
              "Moving all-day events isn't supported yet.",
              "Delete it and create it again.",
            );
          const oldStart = startInstant(event, timeZone);
          const oldEnd = "at" in event.end ? event.end.at : oldStart;
          const start = input.start ? when(input.start, timeZone) : oldStart;
          const end = input.end
            ? when(input.end, timeZone)
            : new Date(
                start.getTime() +
                  (input.duration !== undefined
                    ? input.duration * 60_000
                    : oldEnd.getTime() - oldStart.getTime()),
              );
          if (end <= start)
            throw new ApiFailure(
              "invalid_request",
              "The event must end after it starts.",
            );
          changes.start = { at: start };
          changes.end = { at: end };
        }
        const everyone = [
          ...event.attendees
            .map((a) => a.email)
            .filter((e) => !input.removeAttendees.includes(e)),
          ...input.addAttendees,
        ];
        const notify =
          input.notify ??
          notified(everyone, connection.externalEmail).length > 0;
        const notifies = notify
          ? notified(everyone, connection.externalEmail)
          : [];
        if (input.dryRun)
          return c.json({
            account: account(connection),
            timeZone,
            dryRun: true as const,
            scope: input.scope,
            notifies,
            event: {
              id,
              title: changes.title ?? event.title,
              start: timeDto(changes.start ?? event.start),
              end: timeDto(changes.end ?? event.end),
              allDay: event.allDay,
              attendees: everyone,
              location: changes.location ?? event.location,
              recurrence: changes.recurrence ?? event.recurrence,
            },
          });
        const updated = await audited(
          db,
          {
            userId,
            runId,
            connectionId: connection.id,
            action: "calendar.update",
            targetRef: id,
            summary: `Changed "${event.title}" (${input.scope})${notifies.length ? `, notifying ${notifies.join(", ")}` : ""}`,
            request: { ...input, dryRun: undefined },
          },
          () =>
            provider.update(ref.providerId, changes, {
              scope: input.scope,
              notify,
            }),
          (result) => result.providerId,
        );
        return c.json({
          account: account(connection),
          timeZone,
          dryRun: false as const,
          scope: input.scope,
          notifies,
          event: await dto(userId, connection, updated),
        });
      },
    )
    .post(
      "/events/:id/delete",
      body(deleteBody, "Pass an evt_ id."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        const { ref, connection, provider, event } = await eventFor(
          userId,
          id,
          "delete",
        );
        const everyone = event.attendees.map((a) => a.email);
        const notify =
          input.notify ??
          notified(everyone, connection.externalEmail).length > 0;
        const notifies = notify
          ? notified(everyone, connection.externalEmail)
          : [];
        if (!input.dryRun)
          await audited(
            db,
            {
              userId,
              runId,
              connectionId: connection.id,
              action: "calendar.delete",
              targetRef: id,
              summary: `Deleted "${event.title}" (${input.scope})`,
              request: { scope: input.scope, notify },
            },
            () =>
              provider.delete(ref.providerId, {
                scope: input.scope,
                notify,
              }),
          );
        return c.json({
          dryRun: input.dryRun,
          deleted: id,
          title: event.title,
          scope: input.scope,
          notifies,
        });
      },
    )
    .post(
      "/events/:id/rsvp",
      body(rsvpBody, "Pass --accept, --decline or --tentative."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        const { ref, connection, provider, event } = await eventFor(
          userId,
          id,
          "rsvp",
        );
        if (!event.attendees.some((a) => a.self))
          throw new ApiFailure(
            "not_supported",
            "This account isn't invited to that event, so there's nothing to answer.",
          );
        if (input.dryRun)
          return c.json({
            dryRun: true as const,
            id,
            title: event.title,
            response: input.response,
            note: input.note ?? null,
            scope: input.scope,
            organizer: event.organizer?.email ?? null,
          });
        await audited(
          db,
          {
            userId,
            runId,
            connectionId: connection.id,
            action: "calendar.rsvp",
            targetRef: id,
            summary: `Answered "${event.title}": ${input.response}`,
            request: {
              response: input.response,
              note: input.note,
              scope: input.scope,
            },
          },
          () =>
            provider.rsvp(ref.providerId, input.response, {
              note: input.note,
              scope: input.scope,
            }),
          (result) => result.providerId,
        );
        return c.json({
          dryRun: false as const,
          id,
          title: event.title,
          response: input.response,
          note: input.note ?? null,
          scope: input.scope,
          organizer: event.organizer?.email ?? null,
        });
      },
    );
}
