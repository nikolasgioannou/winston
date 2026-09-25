import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  gmailMessagePreparationSchema,
  gmailPreparedMessageSchema,
  maximumGmailMimeBytes,
  type GmailMessagePreparation,
  type GmailPreparedMessage,
  type GmailOutgoingMessage,
} from "@winston/contracts/gmail-messages";
import { canonicalJson } from "@winston/contracts/json";

export type GmailAttachmentBytes = { artifactId: string; revision: number; bytes: Uint8Array };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const address = (mailbox: GmailOutgoingMessage["from"]) => ({
  address: mailbox.email,
  ...(mailbox.name === undefined ? {} : { name: mailbox.name }),
});

// Pure preparation: callers must resolve owner-scoped artifacts and authorize the exact plan separately.
export async function prepareGmailMessage(
  input: GmailMessagePreparation,
  contents: GmailAttachmentBytes[],
) {
  const parsed = gmailMessagePreparationSchema.parse(input);
  const request = { ...parsed, operationId: parsed.operationId.toLowerCase() };
  const { message } = request;
  if (
    contents.length !== message.attachments.length ||
    new Set(contents.map((item) => item.artifactId)).size !== contents.length
  )
    throw new Error("Attachment contents do not match the message.");
  const attachments = message.attachments.map((attachment) => {
    const content = contents.find((item) => item.artifactId === attachment.artifactId);
    if (
      !content ||
      content.revision !== attachment.revision ||
      !(content.bytes instanceof Uint8Array) ||
      content.bytes.byteLength !== attachment.size
    )
      throw new Error("Attachment identity or contents changed.");
    const bytes = Buffer.from(content.bytes);
    if (digest(bytes) !== attachment.sha256) throw new Error("Attachment contents changed.");
    return {
      filename: attachment.name,
      contentType: attachment.mediaType,
      content: bytes,
      contentDisposition: "attachment" as const,
      contentTransferEncoding: "base64" as const,
    };
  });
  const domain = message.from.email.slice(message.from.email.lastIndexOf("@") + 1).toLowerCase();
  const messageId = `<${request.operationId}@${domain}>`;
  const compiled = new MailComposer({
    from: address(message.from),
    to: message.to.map(address),
    cc: message.cc.map(address),
    bcc: message.bcc.map(address),
    subject: message.subject,
    text: message.text,
    ...(message.html === null ? {} : { html: message.html }),
    ...(message.reply
      ? { inReplyTo: message.reply.inReplyTo, references: message.reply.references }
      : {}),
    attachments,
    date: new Date(request.preparedAt),
    messageId,
    baseBoundary: request.operationId,
    textEncoding: "base64",
    newline: "\r\n",
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  // Gmail reads recipients from MIME headers, including Bcc; there is no SMTP envelope here.
  compiled.keepBcc = true;
  const raw = await compiled.build();
  if (raw.byteLength > maximumGmailMimeBytes)
    throw new Error("Prepared Gmail message exceeds the MIME limit.");
  const plan = gmailPreparedMessageSchema.parse({
    version: 1,
    ...request,
    messageId,
    mimeSize: raw.byteLength,
    mimeSha256: digest(raw),
  });
  return { plan, raw };
}

export async function rebuildGmailMessage(
  input: GmailPreparedMessage,
  contents: GmailAttachmentBytes[],
) {
  const plan = gmailPreparedMessageSchema.parse(input);
  const rebuilt = await prepareGmailMessage(
    {
      operationId: plan.operationId,
      preparedAt: plan.preparedAt,
      target: plan.target,
      message: plan.message,
    },
    contents,
  );
  if (canonicalJson(rebuilt.plan) !== canonicalJson(plan))
    throw new Error("Prepared Gmail content does not match its approved identity.");
  return rebuilt.raw;
}
