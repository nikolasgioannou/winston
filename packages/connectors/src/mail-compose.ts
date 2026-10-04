/**
 * Building outgoing mail (docs/design.md §11 `winston mail`): the pure parts,
 * shared by every provider and by `--dry-run` previews.
 *
 * - **MIME** comes from nodemailer's `MailComposer` (10.x, no dependencies,
 *   works on Bun): RFC 2047 headers for non-ASCII subjects and names,
 *   multipart with base64 attachments, and threading headers. Gmail fills
 *   in the `From` header itself; Winston's own mailbox passes `from`.
 * - **Replies** answer the `Reply-To` (or the sender), thread through
 *   `In-Reply-To` and `References`, and add "Re: " unless the subject has it.
 *   Reply-all adds everyone else from To and Cc, without the user and without
 *   repeats.
 * - **Forwards** keep the original's attachments and put the usual
 *   "Forwarded message" header block under the new text.
 */
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { FullMailMessage, MailAddress, OutgoingMail } from "./mail.ts";

const display = (a: MailAddress) =>
  a.name ? `${a.name} <${a.email}>` : a.email;

/** The raw RFC 5322 message, ready for the provider to upload. */
export async function composeRaw(
  mail: OutgoingMail,
  options: {
    messageId?: string;
    date?: Date;
    /** The sender, when the provider doesn't fill it in. */
    from?: string;
    /** Keep Bcc in the headers for a provider that delivers from them (Gmail). */
    keepBcc?: boolean;
  } = {},
): Promise<Uint8Array> {
  const composer = new MailComposer({
    ...(options.from ? { from: options.from } : {}),
    to: mail.to,
    ...(mail.cc?.length ? { cc: mail.cc } : {}),
    ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
    subject: mail.subject,
    // RFC 5322 lines end in CRLF; agents write plain \n.
    text: mail.body.replace(/\r?\n/g, "\r\n"),
    ...(mail.inReplyTo?.messageIdHeader
      ? {
          inReplyTo: mail.inReplyTo.messageIdHeader,
          references: [
            ...mail.inReplyTo.references,
            mail.inReplyTo.messageIdHeader,
          ],
        }
      : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    ...(options.date ? { date: options.date } : {}),
    attachments: (mail.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.mimeType,
      content: Buffer.from(a.data),
    })),
  });
  const node = composer.compile();
  // Gmail delivers to Bcc recipients from the header, then drops it.
  node.keepBcc = options.keepBcc ?? true;
  return new Uint8Array(await node.build());
}

const reSubject = (subject: string, prefix: "Re" | "Fwd") =>
  new RegExp(`^${prefix}:`, "i").test(subject.trim())
    ? subject
    : `${prefix}: ${subject}`;

/** Unique addresses, in order, leaving out `exclude` (case-insensitive). */
function uniqueAddresses(addresses: MailAddress[], exclude: string[]) {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const a of addresses) {
    const email = a.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(display(a));
  }
  return out;
}

/** A reply to `original`: who it goes to, its subject and threading. */
export function replyTo(
  original: FullMailMessage,
  { body, all, self }: { body: string; all: boolean; self: string },
): OutgoingMail {
  const answering =
    original.replyTo.length > 0
      ? original.replyTo
      : original.from
        ? [original.from]
        : [];
  // Replying to a message the user sent goes back to its recipients.
  const fromSelf = original.from?.email.toLowerCase() === self.toLowerCase();
  const primary = fromSelf ? original.to : answering;
  const to = uniqueAddresses(primary, [self]);
  const cc = all
    ? uniqueAddresses(
        [...original.to, ...original.cc],
        [self, ...primary.map((a) => a.email)],
      )
    : [];
  return {
    to,
    ...(cc.length ? { cc } : {}),
    subject: reSubject(original.subject, "Re"),
    body,
    inReplyTo: threading(original),
  };
}

/** A forward of `original` to new recipients, keeping its attachments. */
export function forwardOf(
  original: FullMailMessage,
  input: {
    to: string[];
    cc?: string[] | undefined;
    bcc?: string[] | undefined;
    body?: string | undefined;
    attachments: OutgoingMail["attachments"];
    /** How the original's date reads in the block, e.g. in the user's zone. */
    date: string;
  },
): OutgoingMail {
  const block = [
    "---------- Forwarded message ---------",
    `From: ${original.from ? display(original.from) : "(unknown)"}`,
    `Date: ${input.date}`,
    `Subject: ${original.subject}`,
    original.to.length > 0
      ? `To: ${original.to.map(display).join(", ")}`
      : undefined,
    original.cc.length > 0
      ? `Cc: ${original.cc.map(display).join(", ")}`
      : undefined,
    "",
    original.body,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  return {
    to: input.to,
    ...(input.cc?.length ? { cc: input.cc } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc } : {}),
    subject: reSubject(original.subject, "Fwd"),
    body: input.body ? `${input.body}\n\n${block}` : block,
    attachments: input.attachments,
    inReplyTo: threading(original),
  };
}

const threading = (original: FullMailMessage) => ({
  threadId: original.threadId,
  messageIdHeader: original.messageIdHeader ?? "",
  references: original.references,
});
