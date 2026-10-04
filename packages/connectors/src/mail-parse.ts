/**
 * Reads a raw RFC 5322 message (docs/design.md §3, Winston's own mailbox):
 * SES hands us mail as MIME, so this turns it into the mail domain's model.
 * Parsing is postal-mime's (no dependencies, bounded nesting and header
 * sizes); bodies read as Gmail's do (`readableBody`).
 */
import PostalMime, { type Address, type Attachment } from "postal-mime";
import type { MailAddress, MailAttachment } from "./mail.ts";
import { readableBody } from "./mail-body.ts";

export interface ParsedMail {
  /** The RFC 5322 Message-ID, angle brackets and all. */
  messageIdHeader: string | null;
  inReplyTo: string | null;
  /** Oldest first, as the header lists them. */
  references: string[];
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  subject: string;
  /** The Date header, if it's a real date. */
  date: Date | null;
  /** What Winston reads: plain text, or the HTML as text. */
  body: string;
  quotedTextHidden: boolean;
  snippet: string;
  /** Parts a person would call attachments; inline images aren't. */
  attachments: MailAttachment[];
}

/** How much of the body a snippet shows. */
const snippetLength = 200;

const parse = (raw: Uint8Array) => PostalMime.parse(raw);

/** A header's value, or null when it's missing or blank. */
const present = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Mailboxes in an address list, groups flattened. */
function mailboxes(addresses: readonly Address[] | undefined): MailAddress[] {
  return (addresses ?? []).flatMap((address) =>
    "group" in address && address.group
      ? address.group.map((m) => ({ name: m.name || null, email: m.address }))
      : "address" in address && address.address
        ? [{ name: address.name || null, email: address.address }]
        : [],
  );
}

/** Each attachment with its part number, which is stable for a given message. */
function attachmentsOf(parsed: { attachments: Attachment[] }) {
  return parsed.attachments
    .map((attachment, index) => ({ attachment, partId: String(index + 1) }))
    .filter(({ attachment }) => !(attachment.related && attachment.contentId));
}

const sizeOf = (content: Attachment["content"]) =>
  typeof content === "string"
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;

export async function parseMail(raw: Uint8Array): Promise<ParsedMail> {
  const parsed = await parse(raw);
  const { body, quotedTextHidden } = readableBody(
    parsed.text ?? undefined,
    parsed.html ?? undefined,
  );
  const date = parsed.date ? new Date(parsed.date) : null;
  return {
    messageIdHeader: present(parsed.messageId),
    inReplyTo: present(parsed.inReplyTo),
    references: (parsed.references ?? "").split(/\s+/).filter(Boolean),
    from: mailboxes(parsed.from ? [parsed.from] : [])[0] ?? null,
    to: mailboxes(parsed.to),
    cc: mailboxes(parsed.cc),
    replyTo: mailboxes(parsed.replyTo),
    subject: parsed.subject?.trim() ?? "",
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    body,
    quotedTextHidden,
    snippet: body.replace(/\s+/g, " ").trim().slice(0, snippetLength),
    attachments: attachmentsOf(parsed).map(({ attachment, partId }) => ({
      providerId: partId,
      filename: attachment.filename ?? "attachment",
      mimeType: attachment.mimeType,
      size: sizeOf(attachment.content),
    })),
  };
}

/** One attachment's bytes, by the part number `parseMail` gave it. */
export async function attachmentContent(
  raw: Uint8Array,
  partId: string,
): Promise<
  { filename: string; mimeType: string; content: Uint8Array } | undefined
> {
  const found = attachmentsOf(await parse(raw)).find(
    (a) => a.partId === partId,
  );
  if (!found) return undefined;
  const { content } = found.attachment;
  return {
    filename: found.attachment.filename ?? "attachment",
    mimeType: found.attachment.mimeType,
    content:
      typeof content === "string"
        ? new TextEncoder().encode(content)
        : new Uint8Array(content),
  };
}
