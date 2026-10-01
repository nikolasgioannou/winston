import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import {
  either,
  listFlag,
  minutes,
  resolveText,
  standardFlags,
  textFlag,
  type FlagSpec,
  type FlagValues,
} from "../flags.ts";
import { json, list } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Events = ApiClient["v1"]["calendar"]["events"];
type Page = InferResponseType<Events["$get"], 200>;
type Detail = InferResponseType<Events[":id"]["$get"], 200>;
type Summary = Page["events"][number];
type Free = InferResponseType<ApiClient["v1"]["calendar"]["free"]["$get"], 200>;
type Created = InferResponseType<Events["$post"], 200>;
type Updated = InferResponseType<Events[":id"]["$patch"], 200>;
type Deleted = InferResponseType<Events[":id"]["delete"]["$post"], 200>;
type Answered = InferResponseType<Events[":id"]["rsvp"]["$post"], 200>;
type Time = { at: string } | { date: string };

/** How much of a description `calendar get` shows unless asked for all of it. */
export const descriptionPreviewChars = 3000;
/** How many attendees `calendar get` lists before pointing at --json. */
const attendeesShown = 20;

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const two = (n: number) => String(n).padStart(2, "0");

/** A day and time of an instant in the user's zone. */
function zoned(iso: string, timeZone: string) {
  const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timeZone);
  return {
    date: z.toPlainDate(),
    clock: `${two(z.hour)}:${two(z.minute)}`,
    offset: z.offset,
  };
}

/** `Tue 09-29`, or `Tue 2026-09-29` with the year. */
const dayName = (date: Temporal.PlainDate, year: boolean) =>
  `${weekdays[date.dayOfWeek - 1] ?? ""} ${year ? `${String(date.year)}-` : ""}${two(date.month)}-${two(date.day)}`;

/**
 * When an event happens, in the user's zone: `Tue 09-29 15:00–15:30 -04:00`,
 * `Tue 09-29 23:00 → Wed 09-30 01:00 -04:00`, `Wed 09-30 all day`, or
 * `Wed 09-30 → Fri 10-02 all day` (all-day ends are exclusive).
 */
export function span(start: Time, end: Time, timeZone: string, year = false) {
  if ("date" in start) {
    const first = Temporal.PlainDate.from(start.date);
    const last =
      "date" in end
        ? Temporal.PlainDate.from(end.date).subtract({ days: 1 })
        : first;
    return Temporal.PlainDate.compare(last, first) > 0
      ? `${dayName(first, year)} → ${dayName(last, year)} all day`
      : `${dayName(first, year)} all day`;
  }
  const from = zoned(start.at, timeZone);
  const to = "at" in end ? zoned(end.at, timeZone) : from;
  return from.date.equals(to.date)
    ? `${dayName(from.date, year)} ${from.clock}–${to.clock} ${to.offset}`
    : `${dayName(from.date, year)} ${from.clock} → ${dayName(to.date, year)} ${to.clock} ${to.offset}`;
}

const plural = (n: number, word: string) =>
  `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/** The user's own answer, when it's worth a mention. */
const answerWords = {
  needs_action: "not answered",
  declined: "declined",
  tentative: "maybe",
  accepted: undefined,
};

/** What an event is, in brackets: `[3 attendees, external, video]`. */
function tags(event: Summary) {
  const all = [
    event.attendees.length > 0
      ? plural(event.attendees.length, "attendee")
      : undefined,
    event.external ? "external" : undefined,
    event.videoLink ? "video" : undefined,
    event.seriesId || event.recurrence ? "repeats" : undefined,
    event.myResponse ? answerWords[event.myResponse] : undefined,
    event.status === "tentative" ? "tentative" : undefined,
  ].filter(Boolean);
  return all.length > 0 ? `[${all.join(", ")}]` : "";
}

/** One line per event, as §11 shows it; the calendar is named when it isn't the account's own. */
export const eventLine = (event: Summary, timeZone: string, account: string) =>
  [
    event.id,
    span(event.start, event.end, timeZone),
    event.title || "(no title)",
    tags(event),
    event.calendar === account ? undefined : event.calendarName,
  ]
    .filter(Boolean)
    .join("  ");

function showPage(page: Page, flags: FlagValues) {
  if (flags.json === true) return json(page);
  return list(
    page.events.map((event) =>
      eventLine(event, page.timeZone, page.account.email),
    ),
    {
      limit: page.events.length || 1,
      ...(page.cursor ? { nextCursor: page.cursor } : {}),
      narrow: "--until, --attendee or --title",
    },
  );
}

const person = (p: { email: string; name: string | null }) =>
  p.name ? `${p.name} <${p.email}>` : p.email;

const responseWords = {
  accepted: "accepted",
  declined: "declined",
  tentative: "maybe",
  needs_action: "hasn't answered",
};

function showDetail(detail: Detail, flags: FlagValues) {
  if (flags.json === true) return json(detail);
  const event = detail.event;
  if (!event) return json(detail);
  const organizer = event.organizer?.email.toLowerCase();
  const lines = [
    `${event.id} · ${event.title || "(no title)"}`,
    `When: ${span(event.start, event.end, detail.timeZone, true)} (${detail.timeZone})`,
    event.seriesId || event.recurrence
      ? `Repeats: ${event.recurrence?.join(" ") ?? "yes"}${event.seriesId ? ` (series ${event.seriesId})` : ""}`
      : undefined,
    event.calendar === detail.account.email
      ? undefined
      : `Calendar: ${event.calendarName}`,
    event.location ? `Where: ${event.location}` : undefined,
    event.videoLink ? `Video: ${event.videoLink}` : undefined,
    event.organizer
      ? `Organizer: ${person(event.organizer)}${event.organizer.self ? " (you)" : ""}`
      : undefined,
    event.status === "confirmed" ? undefined : `Status: ${event.status}`,
    event.external
      ? "Has people from outside the account's organization."
      : undefined,
  ];
  if (event.attendees.length > 0) {
    lines.push(`Attendees (${String(event.attendees.length)}):`);
    for (const a of event.attendees.slice(0, attendeesShown))
      lines.push(
        `  ${person(a)}  ${responseWords[a.response]}${[
          a.email.toLowerCase() === organizer ? ", organizer" : "",
          a.optional ? ", optional" : "",
          a.self ? ", you" : "",
        ].join("")}`,
      );
    if (event.attendees.length > attendeesShown)
      lines.push(
        `  … ${String(event.attendees.length - attendeesShown)} more. To see them all, add --json.`,
      );
  }
  const description = event.description?.trim();
  if (description) {
    lines.push("");
    if (flags.full !== true && description.length > descriptionPreviewChars) {
      lines.push(description.slice(0, descriptionPreviewChars).trimEnd());
      lines.push(
        `… ${String(description.length - descriptionPreviewChars)} more characters. To see them, add --full.`,
      );
    } else lines.push(description);
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

/** Free slots grouped by day, in the user's zone, ready to put in a message. */
function showFree(free: Free, flags: FlagValues) {
  if (flags.json === true) return json(free);
  const clock = (minute: number) =>
    `${String(Math.floor(minute / 60))}:${two(minute % 60)}`;
  const days = new Map<string, string[]>();
  for (const slot of free.slots) {
    const from = zoned(slot.start, free.timeZone);
    const to = zoned(slot.end, free.timeZone);
    const day = dayName(from.date, false);
    days.set(day, [...(days.get(day) ?? []), `${from.clock}–${to.clock}`]);
  }
  const hidden = free.considered.filter((c) => !c.visible).map((c) => c.who);
  return [
    `Free for ${String(free.duration)} min, ${free.hours.weekends ? "every day" : "weekdays"} ${clock(free.hours.start)}–${clock(free.hours.end)}, ${free.timeZone}:`,
    ...(days.size > 0
      ? [...days].map(([day, slots]) => `${day}  ${slots.join(", ")}`)
      : ["No free time in that range."]),
    `Checked: ${free.considered
      .filter((c) => c.visible)
      .map((c) => c.who)
      .join(", ")}`,
    hidden.length > 0
      ? `Couldn't see when ${hidden.join(", ")} ${hidden.length === 1 ? "is" : "are"} busy (not shared), so check with them.`
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const filterFlags: FlagSpec[] = [
  {
    name: "calendar",
    value: "<name|id>",
    description: "Only this calendar (default: the ones the user shows)",
  },
  {
    name: "attendee",
    value: "<address|name>",
    description: "With this attendee",
  },
  { name: "organizer", value: "<address|name>", description: "Organized by" },
  {
    name: "external",
    description: "Only events with people outside the account's organization",
  },
  { name: "title", value: "<text>", description: "Title contains" },
  { ...standardFlags.since, description: "From this time (default now)" },
  {
    ...standardFlags.until,
    description: "Up to this time (default a week after --since)",
  },
  standardFlags.limit,
  standardFlags.cursor,
  standardFlags.account,
];

/** The list/search query, flag for flag. */
function query(flags: FlagValues, search?: string) {
  const entries = {
    account: textFlag(flags, "account"),
    calendar: textFlag(flags, "calendar"),
    text: search,
    attendee: textFlag(flags, "attendee"),
    organizer: textFlag(flags, "organizer"),
    external: flags.external === true ? "true" : undefined,
    title: textFlag(flags, "title"),
    since: textFlag(flags, "since"),
    until: textFlag(flags, "until"),
    limit: typeof flags.limit === "number" ? String(flags.limit) : undefined,
    cursor: textFlag(flags, "cursor"),
  };
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const eventFlags = {
  title: { name: "title", value: "<text>", description: "The title" },
  start: {
    name: "start",
    value: "<time>",
    description:
      'When it starts (in the user\'s zone: "thu 3pm", 2026-10-06T15:00)',
  },
  end: { name: "end", value: "<time>", description: "When it ends" },
  duration: {
    name: "duration",
    value: "<d>",
    description: "How long (30m, 1h, 1h30m)",
  },
  location: { name: "location", value: "<text>", description: "Where" },
  description: {
    name: "description",
    value: "<text>",
    description: "Notes: text, - for stdin, or @path",
    text: true,
  },
  video: { name: "video", description: "Add a Google Meet link" },
  repeat: {
    name: "repeat",
    value: "<RRULE>",
    description: 'Repeat, as an RRULE: "FREQ=WEEKLY;BYDAY=TU"',
  },
  scope: {
    name: "scope",
    value: "this|following|all",
    description:
      "For a repeating event: this one (default), this and following, or all of them",
  },
  notify: {
    name: "notify",
    description: "Email the attendees (the default when there are any)",
  },
  noNotify: { name: "no-notify", description: "Don't email the attendees" },
} satisfies Record<string, FlagSpec>;

/** `--scope`, checked here so a typo is a usage error; `this` by default. */
function scopeOf<T extends string>(flags: FlagValues, allowed: readonly T[]) {
  const value = textFlag(flags, "scope") ?? "this";
  const scope = allowed.find((a) => a === value);
  if (!scope)
    throw CliError.usage(`--scope is ${allowed.join(", ")}, not "${value}".`);
  return scope;
}

const notifyOf = (flags: FlagValues) => {
  const notify = either(flags, "notify", "no-notify");
  return notify === undefined ? {} : { notify };
};

/** Who an email goes to, as a closing line. */
const emails = (notifies: string[], dryRun: boolean) =>
  notifies.length > 0
    ? `${dryRun ? "Would email" : "Emailed"}: ${notifies.join(", ")}`
    : dryRun
      ? "Would email no one."
      : "No one was emailed.";

function showCreated(result: Created, asJson: boolean) {
  if (asJson) return json(result);
  if (result.dryRun) {
    const e = result.event;
    return [
      "DRY RUN (nothing created)",
      `Would create "${e.title}"  ${span(e.start, e.end, result.timeZone)}  in ${e.calendar === "primary" ? result.account.email : e.calendar}`,
      e.attendees.length > 0
        ? `attendees: ${e.attendees.join(", ")}`
        : undefined,
      e.location ? `where: ${e.location}` : undefined,
      e.video ? "with a Google Meet link" : undefined,
      e.recurrence ? `repeats: ${e.recurrence.join(" ")}` : undefined,
      emails(result.notifies, true),
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  const e = result.event;
  return [
    `Created ${e.id} "${e.title}"  ${span(e.start, e.end, result.timeZone)}  in ${result.account.email}.`,
    e.videoLink ? `Video: ${e.videoLink}` : undefined,
    emails(result.notifies, false),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function showUpdated(result: Updated, asJson: boolean) {
  if (asJson) return json(result);
  const e = result.event;
  const scope =
    result.scope === "this"
      ? ""
      : ` (${result.scope === "all" ? "the whole series" : "this and following"})`;
  return [
    result.dryRun ? "DRY RUN (nothing changed)" : undefined,
    `${result.dryRun ? "Would change" : "Changed"} ${e.id}${scope}: "${e.title}"  ${span(e.start, e.end, result.timeZone)}`,
    e.attendees.length > 0
      ? `attendees: ${e.attendees.map((a) => (typeof a === "string" ? a : a.email)).join(", ")}`
      : undefined,
    e.location ? `where: ${e.location}` : undefined,
    emails(result.notifies, result.dryRun),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export const calendar: Resource = {
  name: "calendar",
  ids: ["evt"],
  description:
    "Events in the user's connected calendars: list, find free time, create, change, answer",
  verbs: [
    {
      name: "list",
      summary:
        "Upcoming events, earliest first (now to a week ahead unless --since/--until say otherwise)",
      flags: filterFlags,
      examples: [
        'winston calendar list --since today --until "tomorrow 11:59pm"',
        "winston calendar list --attendee dana@example.com --since mon --until fri",
        "winston calendar list --external --account work@acme.com",
      ],
      run: async ({ client, flags }) =>
        showPage(
          await call<Page>(
            client.v1.calendar.events.$get({ query: query(flags) }),
          ),
          flags,
        ),
    },
    {
      name: "search",
      summary:
        "Events whose title, description, location or attendees match the words",
      usage: "<text>",
      flags: filterFlags,
      examples: [
        "winston calendar search dentist --since today --until 3w",
        'winston calendar search "board meeting" --since 2026-10-01 --until 2026-12-31',
      ],
      run: async ({ client, flags, args }) => {
        const words = args.join(" ").trim();
        if (!words)
          throw CliError.usage(
            "What to look for? Pass some words.",
            "To see everything, use winston calendar list.",
          );
        return showPage(
          await call<Page>(
            client.v1.calendar.events.$get({ query: query(flags, words) }),
          ),
          flags,
        );
      },
    },
    {
      name: "get",
      summary:
        "An event with its attendees and their answers, video link and notes",
      usage: "<evt_id>",
      flags: [
        {
          name: "full",
          description: `The whole description (by default it stops after ${String(descriptionPreviewChars)} characters)`,
        },
      ],
      examples: ["winston calendar get evt_01k5…"],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id)
          throw CliError.usage(
            "Which event? Pass an evt_ id.",
            "Get ids from winston calendar list or search.",
          );
        return showDetail(
          await call<Detail>(
            client.v1.calendar.events[":id"].$get({ param: { id } }),
          ),
          flags,
        );
      },
    },
    {
      name: "free",
      summary:
        "Free slots in working hours, the user's and attendees' where their calendars are visible",
      flags: [
        { ...standardFlags.since, description: "From this time (default now)" },
        {
          ...standardFlags.until,
          description: "Up to this time (default a week after --since)",
        },
        {
          name: "duration",
          value: "<d>",
          description: "How long the slot must be (default 30m)",
        },
        {
          name: "attendee",
          value: "<address>",
          description: "Someone else who must be free (repeat for more)",
          repeatable: true,
        },
        {
          name: "hours",
          value: "<from-to>",
          description:
            "Working hours in the user's zone (default 9-18; also 9:30-17:30 or 10am-6pm)",
        },
        { name: "weekends", description: "Include Saturdays and Sundays" },
        standardFlags.account,
      ],
      examples: [
        'winston calendar free --attendee dana@example.com --duration 30m --since "next mon" --until "next sat"',
        "winston calendar free --since tomorrow --until 3d --duration 1h --hours 10-16",
      ],
      run: async ({ client, flags }) => {
        const duration = textFlag(flags, "duration");
        const entries = {
          account: textFlag(flags, "account"),
          since: textFlag(flags, "since"),
          until: textFlag(flags, "until"),
          duration:
            duration === undefined ? undefined : String(minutes(duration)),
          hours: textFlag(flags, "hours"),
          weekends: flags.weekends === true ? "true" : undefined,
        };
        const free = await call<Free>(
          client.v1.calendar.free.$get({
            query: {
              ...Object.fromEntries(
                Object.entries(entries).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              attendee: listFlag(flags, "attendee"),
            },
          }),
        );
        return showFree(free, flags);
      },
    },
    {
      name: "create",
      summary:
        "Add an event; attendees are emailed an invitation unless --no-notify",
      flags: [
        eventFlags.title,
        eventFlags.start,
        eventFlags.end,
        eventFlags.duration,
        { name: "all-day", description: "All day on --start's date" },
        {
          name: "attendee",
          value: "<address>",
          description: "Invite someone (repeat for more)",
          repeatable: true,
        },
        eventFlags.location,
        eventFlags.description,
        eventFlags.video,
        eventFlags.repeat,
        {
          name: "calendar",
          value: "<name|id>",
          description: "Which calendar (default the account's own)",
        },
        eventFlags.notify,
        eventFlags.noNotify,
        standardFlags.dryRun,
        standardFlags.account,
      ],
      examples: [
        'winston calendar create --title "1:1 with Sam" --start "tue 10am" --duration 30m --attendee sam@acme.com --video --repeat "FREQ=WEEKLY;BYDAY=TU" --dry-run',
        'winston calendar create --title "Dentist" --start "2026-10-14T08:30" --end "2026-10-14T09:30" --location "12 Main St"',
        'winston calendar create --title "Offsite" --start 2026-11-03 --all-day --no-notify',
      ],
      run: async (context) => {
        const { client, flags } = context;
        const title = textFlag(flags, "title");
        const start = textFlag(flags, "start");
        if (title === undefined) throw CliError.usage("--title is required.");
        if (start === undefined)
          throw CliError.usage(
            "--start is required.",
            'For example --start "thu 3pm".',
          );
        const end = textFlag(flags, "end");
        const duration = textFlag(flags, "duration");
        const allDay = flags["all-day"] === true;
        if (
          [end !== undefined, duration !== undefined, allDay].filter(Boolean)
            .length !== 1
        )
          throw CliError.usage(
            "Say how long: exactly one of --end, --duration or --all-day.",
          );
        const description = textFlag(flags, "description");
        return showCreated(
          await call<Created>(
            client.v1.calendar.events.$post({
              json: {
                ...(textFlag(flags, "account")
                  ? { account: textFlag(flags, "account") }
                  : {}),
                ...(textFlag(flags, "calendar")
                  ? { calendar: textFlag(flags, "calendar") }
                  : {}),
                title,
                start,
                ...(end === undefined ? {} : { end }),
                ...(duration === undefined
                  ? {}
                  : { duration: minutes(duration) }),
                allDay,
                attendees: listFlag(flags, "attendee"),
                ...(textFlag(flags, "location")
                  ? { location: textFlag(flags, "location") }
                  : {}),
                ...(description === undefined
                  ? {}
                  : {
                      description: await resolveText(description, context.text),
                    }),
                video: flags.video === true,
                ...(textFlag(flags, "repeat")
                  ? { repeat: textFlag(flags, "repeat") }
                  : {}),
                ...notifyOf(flags),
                dryRun: flags["dry-run"] === true,
              },
            }),
          ),
          flags.json === true,
        );
      },
    },
    {
      name: "update",
      summary:
        "Change an event: time, title, place, attendees; moving keeps its length",
      usage: "<evt_id>",
      flags: [
        eventFlags.title,
        eventFlags.start,
        eventFlags.end,
        eventFlags.duration,
        eventFlags.location,
        eventFlags.description,
        eventFlags.video,
        eventFlags.repeat,
        {
          name: "add-attendee",
          value: "<address>",
          description: "Invite someone (repeat for more)",
          repeatable: true,
        },
        {
          name: "remove-attendee",
          value: "<address>",
          description: "Take someone off it (repeat for more)",
          repeatable: true,
        },
        eventFlags.scope,
        eventFlags.notify,
        eventFlags.noNotify,
        standardFlags.dryRun,
      ],
      examples: [
        'winston calendar update evt_01k5… --start "thu 3pm" --notify --dry-run',
        "winston calendar update evt_01k5… --add-attendee sam@acme.com --scope following",
        'winston calendar update evt_01k5… --title "Plan review (moved online)" --video --no-notify',
      ],
      run: async (context) => {
        const { client, flags, args } = context;
        const [id] = args;
        if (!id) throw CliError.usage("Which event? Pass an evt_ id.");
        const duration = textFlag(flags, "duration");
        const description = textFlag(flags, "description");
        const changes = {
          ...(textFlag(flags, "title")
            ? { title: textFlag(flags, "title") }
            : {}),
          ...(textFlag(flags, "start")
            ? { start: textFlag(flags, "start") }
            : {}),
          ...(textFlag(flags, "end") ? { end: textFlag(flags, "end") } : {}),
          ...(duration === undefined ? {} : { duration: minutes(duration) }),
          ...(textFlag(flags, "location") === undefined
            ? {}
            : { location: textFlag(flags, "location") }),
          ...(description === undefined
            ? {}
            : { description: await resolveText(description, context.text) }),
          ...(flags.video === true ? { video: true } : {}),
          ...(textFlag(flags, "repeat")
            ? { repeat: textFlag(flags, "repeat") }
            : {}),
          addAttendees: listFlag(flags, "add-attendee"),
          removeAttendees: listFlag(flags, "remove-attendee"),
        };
        if (
          Object.keys(changes).length === 2 &&
          !changes.addAttendees.length &&
          !changes.removeAttendees.length
        )
          throw CliError.usage(
            "Nothing to change.",
            "Pass a field to change, like --start or --title.",
          );
        const scope = scopeOf(flags, ["this", "following", "all"] as const);
        return showUpdated(
          await call<Updated>(
            client.v1.calendar.events[":id"].$patch({
              param: { id },
              json: {
                ...changes,
                scope,
                ...notifyOf(flags),
                dryRun: flags["dry-run"] === true,
              },
            }),
          ),
          flags.json === true,
        );
      },
    },
    {
      name: "delete",
      summary:
        "Delete an event (attendees are told it's cancelled unless --no-notify)",
      usage: "<evt_id>",
      flags: [
        eventFlags.scope,
        eventFlags.notify,
        eventFlags.noNotify,
        standardFlags.dryRun,
      ],
      examples: [
        "winston calendar delete evt_01k5… --dry-run",
        "winston calendar delete evt_01k5… --scope following",
      ],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id) throw CliError.usage("Which event? Pass an evt_ id.");
        const scope = scopeOf(flags, ["this", "following", "all"] as const);
        const result = await call<Deleted>(
          client.v1.calendar.events[":id"].delete.$post({
            param: { id },
            json: {
              scope,
              ...notifyOf(flags),
              dryRun: flags["dry-run"] === true,
            },
          }),
        );
        if (flags.json === true) return json(result);
        const which =
          result.scope === "all"
            ? " (the whole series)"
            : result.scope === "following"
              ? " (this and following)"
              : "";
        return [
          result.dryRun ? "DRY RUN (nothing deleted)" : undefined,
          `${result.dryRun ? "Would delete" : "Deleted"} ${result.deleted} "${result.title}"${which}.`,
          emails(result.notifies, result.dryRun),
        ]
          .filter((line) => line !== undefined)
          .join("\n");
      },
    },
    {
      name: "rsvp",
      summary: "Answer an invitation; the organizer is told",
      usage: "<evt_id>",
      flags: [
        { name: "accept", description: "Going" },
        { name: "decline", description: "Not going" },
        { name: "tentative", description: "Maybe" },
        {
          name: "note",
          value: "<text>",
          description: "A note for the organizer",
        },
        {
          name: "scope",
          value: "this|all",
          description:
            "For a repeating event: this one (default) or all of them",
        },
        standardFlags.dryRun,
      ],
      examples: [
        'winston calendar rsvp evt_01k5… --decline --note "Out that day, sorry. Can we move it?"',
        "winston calendar rsvp evt_01k5… --accept --scope all",
      ],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id) throw CliError.usage("Which event? Pass an evt_ id.");
        const chosen = (["accept", "decline", "tentative"] as const).filter(
          (name) => flags[name] === true,
        );
        const [answer] = chosen;
        if (chosen.length !== 1 || !answer)
          throw CliError.usage(
            "Pick one of --accept, --decline and --tentative.",
          );
        const response = (
          {
            accept: "accepted",
            decline: "declined",
            tentative: "tentative",
          } as const
        )[answer];
        const scope = scopeOf(flags, ["this", "all"] as const);
        const note = textFlag(flags, "note");
        const result = await call<Answered>(
          client.v1.calendar.events[":id"].rsvp.$post({
            param: { id },
            json: {
              response,
              ...(note === undefined ? {} : { note }),
              scope,
              dryRun: flags["dry-run"] === true,
            },
          }),
        );
        if (flags.json === true) return json(result);
        const said = {
          accepted: "Accepted",
          declined: "Declined",
          tentative: "Answered maybe to",
        }[result.response];
        return [
          result.dryRun ? "DRY RUN (nothing sent)" : undefined,
          `${result.dryRun ? `Would answer ${result.response}:` : said} ${result.id} "${result.title}"${result.scope === "all" ? " (the whole series)" : ""}${result.note ? ` with the note "${result.note}"` : ""}.`,
          result.organizer
            ? `${result.dryRun ? "Would tell" : "Told"} ${result.organizer}.`
            : undefined,
        ]
          .filter((line) => line !== undefined)
          .join("\n");
      },
    },
  ],
};
