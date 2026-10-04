/**
 * The event catalog (docs/design.md §3, Part 3 invariant 9): every event's
 * name, meaning, payload, and how Winston can subscribe to it. Defined once
 * as data; the CLI's `winston events catalog`, subscriptions and matching all
 * read it, so they can't drift apart.
 */
import { z } from "zod";
import {
  mailImpersonationPayloadSchema,
  reactionPayloadSchema,
  taskNeedsUserPayloadSchema,
  taskResultPayloadSchema,
  userEmailPayloadSchema,
  userMessagePayloadSchema,
} from "./inbound.ts";

/**
 * Subscription filter fields: the same names and meanings as the CLI's domain
 * flags, so `--from` means the same in `winston mail search` and in
 * `winston trigger create --on mail.message.received`.
 */
export const filterFields = {
  // mail
  from: { value: "<address|name>", description: "Sent by" },
  to: { value: "<address|name>", description: "Sent to" },
  subject: { value: "<text>", description: "Subject contains" },
  unread: { description: "Only unread mail" },
  "has-attachment": { description: "Only mail with attachments" },
  label: { value: "<name>", description: "Has this label" },
  category: {
    value: "<name>",
    description:
      "In this category (primary, promotions, social, updates, forums)",
  },
  "is-reply-to-user": {
    description: "Only replies in threads where the user sent the last message",
  },
  // calendar
  calendar: { value: "<name|id>", description: "On this calendar" },
  attendee: { value: "<address|name>", description: "With this attendee" },
  organizer: { value: "<address|name>", description: "Organized by" },
  external: {
    description: "Only events with people outside the account's organization",
  },
  title: { value: "<text>", description: "Title contains" },
  "min-attendees": {
    value: "<n>",
    description: "With at least this many attendees",
    integer: true,
  },
} as const satisfies Record<
  string,
  { value?: string; description: string; integer?: boolean }
>;

export type FilterField = keyof typeof filterFields;

const mailFilters = [
  "from",
  "to",
  "subject",
  "unread",
  "has-attachment",
  "label",
  "category",
  "is-reply-to-user",
] as const satisfies readonly FilterField[];

const calendarFilters = [
  "calendar",
  "attendee",
  "organizer",
  "external",
  "title",
  "min-attendees",
] as const satisfies readonly FilterField[];

const person = z.object({ name: z.string().nullable(), email: z.string() });

/** A connection's facts, as system events carry them. */
const connectionFacts = z.object({
  connectionId: z.string(),
  domain: z.enum(["mail", "calendar"]),
  provider: z.string(),
  externalEmail: z.string(),
});

/** A message as mail events carry it, with the CLI's ids. */
const mailMessage = z.object({
  messageId: z.string(),
  threadId: z.string(),
  /** The account it arrived in or was sent from. */
  account: z.string(),
  from: person.nullable(),
  to: z.array(person),
  cc: z.array(person),
  subject: z.string(),
  snippet: z.string(),
  date: z.iso.datetime(),
});

const eventTime = z.union([
  z.object({ at: z.iso.datetime() }),
  z.object({ date: z.iso.date() }),
]);

/** A calendar event as calendar events carry it, with the CLI's id. */
const calendarEvent = z.object({
  eventId: z.string(),
  account: z.string(),
  calendar: z.string(),
  title: z.string(),
  start: eventTime,
  end: eventTime,
  allDay: z.boolean(),
  location: z.string().nullable(),
  organizer: person.nullable(),
  attendees: z.array(
    person.extend({
      response: z.enum(["needs_action", "accepted", "declined", "tentative"]),
    }),
  ),
  external: z.boolean(),
  videoLink: z.string().nullable(),
});

export interface EventDefinition {
  type: string;
  /** Where it comes from; `winston events catalog <domain>` lists one. */
  domain: "conversation" | "task" | "system" | "mail" | "calendar";
  /** One line, for `--help` and the catalog. */
  description: string;
  /** Always delivered to the front of house, or only to subscriptions that ask. */
  delivery: "always" | "subscribable";
  payload: z.ZodType;
  /** The filter fields a subscription to it can use. */
  filters: readonly FilterField[];
  /** What a subscription can be scoped to: one thread or one event. */
  scope?: "thread" | "event";
  /** Derived from other events and time, rather than reported by a provider. */
  abstraction?: boolean;
  /** Takes `--lead` (how long before). */
  lead?: boolean;
}

const define = <const T extends readonly EventDefinition[]>(events: T) =>
  events;

export const eventCatalog = define([
  // Always delivered: the conversation's plumbing.
  {
    type: "user_message",
    domain: "conversation",
    description: "The user sent a Telegram message.",
    delivery: "always",
    payload: userMessagePayloadSchema,
    filters: [],
  },
  {
    type: "user_email",
    domain: "conversation",
    description:
      "The user emailed Winston's own address (a forward or a CC), proven to come from one of their addresses.",
    delivery: "always",
    payload: userEmailPayloadSchema,
    filters: [],
  },
  {
    type: "telegram.reaction.added",
    domain: "conversation",
    description: "The user reacted to one of Winston's messages.",
    delivery: "always",
    payload: reactionPayloadSchema,
    filters: [],
  },
  {
    type: "task.completed",
    domain: "task",
    description: "A background task finished, with its report.",
    delivery: "always",
    payload: taskResultPayloadSchema,
    filters: [],
  },
  {
    type: "task.failed",
    domain: "task",
    description: "A background task couldn't finish.",
    delivery: "always",
    payload: taskResultPayloadSchema,
    filters: [],
  },
  {
    type: "task.needs_user",
    domain: "task",
    description: "A background task handed over to the user and is waiting.",
    delivery: "always",
    payload: taskNeedsUserPayloadSchema,
    filters: [],
  },
  {
    type: "system.handoff.done",
    domain: "system",
    description:
      "The user tapped Done on the live view of the front of house's browser.",
    delivery: "always",
    payload: z.object({ handoffId: z.string() }),
    filters: [],
  },
  {
    type: "system.onboarding.completed",
    domain: "system",
    description: "The user linked Telegram from the website.",
    delivery: "always",
    payload: z.object({}),
    filters: [],
  },
  {
    type: "system.app.auth_expiring",
    domain: "system",
    description: "A connected account's access runs out soon.",
    delivery: "always",
    payload: connectionFacts.extend({
      expiresAt: z.iso.datetime(),
      reconnectUrl: z.string(),
    }),
    filters: [],
  },
  {
    type: "system.app.auth_expired",
    domain: "system",
    description: "A connected account's access ran out.",
    delivery: "always",
    payload: connectionFacts.extend({
      expiresAt: z.iso.datetime(),
      reconnectUrl: z.string(),
    }),
    filters: [],
  },
  {
    type: "system.site.paused",
    domain: "system",
    description:
      "One of the user's sites was paused (docs/design.md §9a): over its monthly request cap, its database over its size cap, the user over their monthly hosting spend, or every site switched off. Visitors see a paused page until it's resumed.",
    delivery: "always",
    payload: z.object({
      siteId: z.string(),
      name: z.string(),
      reason: z.enum(["requests", "database", "spend", "kill_switch"]),
      /** When it comes back by itself (the next month), or null. */
      resumesAt: z.iso.datetime().nullable(),
    }),
    filters: [],
  },
  // Subscribable.
  {
    type: "mail.message.received",
    domain: "mail",
    description: "A new message arrived in the inbox, not sent by the user.",
    delivery: "subscribable",
    payload: mailMessage.extend({
      labels: z.array(z.string()),
      category: z.string().nullable(),
      unread: z.boolean(),
      hasAttachments: z.boolean(),
      /** In a thread where the user sent the last message before it. */
      isReplyToUser: z.boolean(),
    }),
    filters: mailFilters,
    scope: "thread",
  },
  {
    type: "mail.message.sent",
    domain: "mail",
    description:
      "The user sent a message, from any app (so Winston sees they already replied).",
    delivery: "subscribable",
    payload: mailMessage,
    filters: ["to", "subject", "has-attachment"],
    scope: "thread",
  },
  {
    type: "mail.message.labels_changed",
    domain: "mail",
    description:
      "A message was read or marked unread, starred, archived or labeled.",
    delivery: "subscribable",
    payload: z.object({
      messageId: z.string(),
      threadId: z.string(),
      account: z.string(),
      /** Label names, with `inbox`, `unread` and `starred` for those flags. */
      added: z.array(z.string()),
      removed: z.array(z.string()),
    }),
    filters: ["label"],
    scope: "thread",
  },
  {
    type: "mail.impersonation.suspected",
    domain: "mail",
    description:
      "Mail to Winston's own address claimed to be from the user but failed SES's DKIM or DMARC check.",
    delivery: "always",
    payload: mailImpersonationPayloadSchema,
    filters: [],
  },
  {
    type: "calendar.invitation.received",
    domain: "calendar",
    description: "Someone else invited the user to an event.",
    delivery: "subscribable",
    payload: z.object({ event: calendarEvent }),
    filters: calendarFilters,
  },
  {
    type: "calendar.event.created",
    domain: "calendar",
    description:
      "An event was added to the user's calendar, by them or by Winston.",
    delivery: "subscribable",
    payload: z.object({ event: calendarEvent }),
    filters: calendarFilters,
  },
  {
    type: "calendar.event.updated",
    domain: "calendar",
    description:
      "An event's time, place, attendees, description or video link changed.",
    delivery: "subscribable",
    payload: z.object({
      event: calendarEvent,
      changes: z.array(
        z.object({
          field: z.string(),
          before: z.unknown(),
          after: z.unknown(),
        }),
      ),
    }),
    filters: calendarFilters,
    scope: "event",
  },
  {
    type: "calendar.event.cancelled",
    domain: "calendar",
    description: "An event was deleted or cancelled.",
    delivery: "subscribable",
    payload: z.object({ event: calendarEvent }),
    filters: calendarFilters,
    scope: "event",
  },
  {
    type: "calendar.rsvp.changed",
    domain: "calendar",
    description: "Someone answered an invitation to one of the user's events.",
    delivery: "subscribable",
    payload: z.object({
      event: calendarEvent,
      attendee: person,
      response: z.enum(["needs_action", "accepted", "declined", "tentative"]),
    }),
    filters: calendarFilters,
    scope: "event",
  },
  {
    type: "calendar.event.starting",
    domain: "calendar",
    description:
      "An event starts soon (by --lead), following moves and cancellations.",
    delivery: "subscribable",
    payload: z.object({ event: calendarEvent, leadMinutes: z.number().int() }),
    filters: calendarFilters,
    scope: "event",
    abstraction: true,
    lead: true,
  },
  {
    type: "system.app.connected",
    domain: "system",
    description: "The user connected an account on the website.",
    delivery: "subscribable",
    payload: connectionFacts,
    filters: [],
  },
  {
    type: "system.app.disconnected",
    domain: "system",
    description:
      "The user disconnected an account; its subscriptions end with it.",
    delivery: "subscribable",
    payload: connectionFacts.extend({
      /** The subscriptions that ended with it, so notes can be updated. */
      cancelledTriggers: z.array(z.string()).optional(),
    }),
    filters: [],
  },
  {
    type: "system.settings.changed",
    domain: "system",
    description: "A setting changed, such as the time zone.",
    delivery: "subscribable",
    payload: z.object({
      field: z.string(),
      old: z.unknown(),
      new: z.unknown(),
      /** Who changed it: the user on the site, their browser, or Winston. */
      source: z.enum(["site", "browser", "winston"]),
    }),
    filters: [],
  },
]);

export type EventType = (typeof eventCatalog)[number]["type"];

/** A catalog entry by type, or undefined if there's no such event. */
export function eventDefinition(type: string): EventDefinition | undefined {
  return eventCatalog.find((definition) => definition.type === type);
}

/**
 * Checks an event's payload against the catalog: throws for an unknown type
 * or a payload that doesn't match, so malformed events never get stored.
 */
export function parseEventPayload(type: string, payload: unknown): unknown {
  const definition = eventDefinition(type);
  if (!definition) throw new Error(`Not a catalog event: ${type}`);
  const parsed = definition.payload.safeParse(payload);
  if (!parsed.success)
    throw new Error(
      `A ${type} payload doesn't match the catalog: ${z.prettifyError(parsed.error)}`,
    );
  return parsed.data;
}

/** An event's payload fields and their types, from its schema, for the catalog listing. */
export function payloadFields(definition: EventDefinition) {
  const schema = z.toJSONSchema(definition.payload, { io: "input" }) as {
    properties?: Record<string, { type?: string | string[]; anyOf?: unknown }>;
  };
  return Object.entries(schema.properties ?? {}).map(([name, field]) => ({
    name,
    type: Array.isArray(field.type)
      ? field.type.join("|")
      : (field.type ?? "object"),
  }));
}
