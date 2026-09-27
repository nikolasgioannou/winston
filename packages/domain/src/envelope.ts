/**
 * Renders inbound items into the `<system_event>` envelopes agents read
 * (docs/design.md §4, "The envelope"). Two boundaries depend on this module:
 *
 * - Security: every interpolated string is XML-escaped, so no payload (an
 *   email body, a web page, the user's own text) can close a tag or open a
 *   fake envelope. Only `renderUserMessage` produces `type="user_message"`.
 * - Caching: output depends only on the inputs (never the clock or the
 *   process's time zone), so the same item always renders to the same bytes.
 */
import { formatInTimeZone } from "@winston/shared/time";
import type { UserMessagePayload } from "./inbound.ts";

/** The message a user message replies to, resolved by the caller. */
export interface ReplyContext {
  from: "user" | "winston";
  text: string;
}

export interface UserMessageItem {
  occurredAt: Date;
  payload: UserMessagePayload;
  /** Set when the replied-to message was found; a reply without it renders as `<reply_to/>`. */
  replyTo?: ReplyContext;
}

export interface EventItem {
  /** A catalog event type, e.g. `mail.message.received`. */
  type: string;
  occurredAt: Date;
  data: unknown;
  /** Winston's note on the subscription that delivered the event. */
  subscriptionNote?: string;
}

export type EnvelopeItem =
  | ({ kind: "user_message" } & UserMessageItem)
  | ({ kind: "event" } & EventItem);

/** How much of a replied-to message is quoted. */
export const replyQuoteMaxChars = 300;

const eventTypePattern = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** Escapes text for XML element content. */
function escapeText(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Escapes text for a double-quoted attribute value. */
function escapeAttribute(text: string) {
  return escapeText(text).replaceAll('"', "&quot;");
}

function element(name: string, content: string) {
  return `  <${name}>${escapeText(content)}</${name}>`;
}

function attributes(values: Record<string, string | undefined>) {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function envelope(type: string, lines: string[]) {
  return [
    `<system_event type="${escapeAttribute(type)}">`,
    ...lines,
    "</system_event>",
  ].join("\n");
}

/** Cuts at a code point boundary, so emoji and other astral characters stay whole. */
function truncate(text: string, maxChars: number) {
  const chars = Array.from(text);
  return chars.length <= maxChars
    ? text
    : `${chars.slice(0, maxChars).join("")}…`;
}

/** The only renderer that may produce a `user_message` envelope: real Telegram messages only. */
export function renderUserMessage(item: UserMessageItem, timeZone: string) {
  const { payload } = item;
  const lines = [
    element("sent_at", formatInTimeZone(item.occurredAt, timeZone)),
  ];
  if (payload.forwardedFrom) {
    const origin = payload.forwardedFrom;
    const sentAt = formatInTimeZone(new Date(origin.sentAt), timeZone);
    lines.push(
      `  <forwarded_from${attributes({ kind: origin.kind, username: origin.username, sent_at: sentAt })}>${escapeText(origin.name)}</forwarded_from>`,
    );
  }
  if (payload.replyToTelegramMessageId !== undefined) {
    lines.push(
      item.replyTo
        ? `  <reply_to${attributes({ from: item.replyTo.from })}>${escapeText(truncate(item.replyTo.text, replyQuoteMaxChars))}</reply_to>`
        : "  <reply_to/>",
    );
  }
  lines.push(element("text", payload.text));
  return envelope("user_message", lines);
}

/** Any catalog event. Its data is untrusted and rendered as escaped, key-sorted JSON. */
export function renderEvent(item: EventItem, timeZone: string) {
  if (!eventTypePattern.test(item.type))
    throw new Error(`Not a catalog event type: ${item.type}`);
  const lines = [
    element("occurred_at", formatInTimeZone(item.occurredAt, timeZone)),
  ];
  if (item.subscriptionNote !== undefined)
    lines.push(element("subscription_note", item.subscriptionNote));
  lines.push(element("data", canonicalJson(item.data)));
  return envelope(item.type, lines);
}

/** Renders a batch of items as the content of one user-role message. */
export function renderBatch(items: readonly EnvelopeItem[], timeZone: string) {
  return items
    .map((item) =>
      item.kind === "user_message"
        ? renderUserMessage(item, timeZone)
        : renderEvent(item, timeZone),
    )
    .join("\n\n");
}

/** JSON with object keys sorted at every level, so key order never changes the bytes. */
function canonicalJson(value: unknown) {
  return JSON.stringify(value ?? null, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}
