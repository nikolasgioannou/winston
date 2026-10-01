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
import { canonicalJson } from "@winston/shared/json";
import { formatInTimeZone } from "@winston/shared/time";
import type {
  Attachment,
  TaskNeedsUserPayload,
  TaskResultPayload,
  TaskResultType,
  UserMessagePayload,
} from "./inbound.ts";

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

/** A background run's outcome, or its handing over to the user, for the front of house. */
export type TaskItem =
  | { type: TaskResultType; occurredAt: Date; payload: TaskResultPayload }
  | {
      type: "task.needs_user";
      occurredAt: Date;
      payload: TaskNeedsUserPayload;
    };

export type EnvelopeItem =
  | ({ kind: "user_message" } & UserMessageItem)
  | ({ kind: "event" } & EventItem)
  | ({ kind: "task" } & TaskItem);

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
  if (payload.attachment) lines.push(renderAttachment(payload.attachment));
  // The text is what the user said in a voice or video note.
  if (payload.source === "voice") lines.push(element("source", "voice"));
  // A file sent without a caption has no text.
  if (payload.text !== "" || !payload.attachment)
    lines.push(element("text", payload.text));
  return envelope("user_message", lines);
}

/** Why a file isn't on the VM, in words the model can pass on. */
const attachmentProblems: Partial<Record<Attachment["status"], string>> = {
  too_large: "Not saved: Telegram only lets bots download files up to 20 MB.",
  failed: "Not saved: downloading it failed.",
};

/** A file the user sent: where it was saved, or why it wasn't. */
function renderAttachment(attachment: Attachment) {
  const saved = attachment.status === "saved";
  const attrs = attributes({
    kind: attachment.kind,
    path: saved ? attachment.path : undefined,
    name: saved ? undefined : attachment.fileName,
    type: attachment.mimeType,
    size:
      attachment.size === undefined ? undefined : formatSize(attachment.size),
    status: saved ? undefined : attachment.status,
  });
  const problem = attachment.transcriptionFailed
    ? "Not transcribed: the speech couldn't be made out."
    : attachmentProblems[attachment.status];
  return problem
    ? `  <attachment${attrs}>${escapeText(problem)}</attachment>`
    : `  <attachment${attrs}/>`;
}

/** Sizes as people write them: bytes, then KB and MB to one decimal (1 KB = 1024 bytes). */
export function formatSize(bytes: number) {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/**
 * The contents of a text file the user sent, shown alongside the message.
 * The file could say anything, so it's escaped like any untrusted content.
 */
export function renderAttachmentContent(path: string, text: string) {
  return `<attachment_content${attributes({ path })}>\n${escapeText(text)}\n</attachment_content>`;
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

/**
 * A background run's report or failure. The report is the agent's own words,
 * but it may quote outside content, so it's escaped like everything else.
 */
export function renderTaskResult(item: TaskItem, timeZone: string) {
  const at = element(
    "occurred_at",
    formatInTimeZone(item.occurredAt, timeZone),
  );
  if (item.type === "task.needs_user")
    return envelope(item.type, [
      at,
      `  <task${attributes({ id: item.payload.taskId })}>${escapeText(item.payload.brief)}</task>`,
      element("reason", item.payload.reason),
    ]);
  const { payload } = item;
  return envelope(item.type, [
    at,
    `  <task${attributes({ id: payload.taskId, capped: payload.capped ? "true" : undefined, cancelled: payload.cancelled ? "true" : undefined })}>${escapeText(payload.brief)}</task>`,
    element(item.type === "task.failed" ? "error" : "report", payload.report),
  ]);
}

/** Renders a batch of items as the content of one user-role message. */
export function renderBatch(items: readonly EnvelopeItem[], timeZone: string) {
  return items
    .map((item) =>
      item.kind === "user_message"
        ? renderUserMessage(item, timeZone)
        : item.kind === "task"
          ? renderTaskResult(item, timeZone)
          : renderEvent(item, timeZone),
    )
    .join("\n\n");
}
