import { z } from "zod";
import { resolvedTargetSchema } from "./connection-targets";
import { gmailIdSchema } from "./gmail";
import { artifactMetadataSchema } from "./artifacts";

export const maximumGmailAttachmentBytes = 25_000_000;
export const maximumGmailMimeBytes = 35_000_000;
const header = z
  .string()
  .max(2000)
  .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), "Header controls are not allowed.");
export const gmailMailboxSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .regex(/^[\x21-\x7e]+$/),
  name: header.optional(),
});
const messageId = z
  .string()
  .max(998)
  .regex(/^<[^<>\s@\p{Cc}]+@[^<>\s@\p{Cc}]+>$/u);
export const gmailMessageAttachmentSchema = artifactMetadataSchema
  .pick({
    name: true,
    size: true,
    sha256: true,
  })
  .extend({
    artifactId: z.uuid(),
    revision: z.number().int().nonnegative(),
    mediaType: z
      .string()
      .max(255)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    size: z.number().int().nonnegative().max(maximumGmailAttachmentBytes),
  });
export const gmailOutgoingMessageSchema = z
  .strictObject({
    from: gmailMailboxSchema,
    to: z.array(gmailMailboxSchema).max(100),
    cc: z.array(gmailMailboxSchema).max(100),
    bcc: z.array(gmailMailboxSchema).max(100),
    subject: header,
    text: z
      .string()
      .max(100_000)
      .refine((value) => !value.includes("\0")),
    html: z
      .string()
      .max(100_000)
      .refine((value) => !value.includes("\0"))
      .nullable(),
    reply: z
      .strictObject({
        sourceMessageId: gmailIdSchema,
        threadId: gmailIdSchema,
        inReplyTo: messageId,
        references: z.array(messageId).min(1).max(50),
      })
      .refine(
        (reply) => reply.references.at(-1) === reply.inReplyTo,
        "References must end with the parent Message-ID.",
      )
      .nullable(),
    attachments: z.array(gmailMessageAttachmentSchema).max(20),
  })
  .refine((message) => {
    const recipients = [...message.to, ...message.cc, ...message.bcc];
    return (
      recipients.length <= 100 &&
      new Set(recipients.map((item) => item.email.toLowerCase())).size === recipients.length
    );
  }, "Recipients must be distinct across To, Cc and Bcc, with at most 100 total.")
  .refine(
    (message) =>
      new Set(message.attachments.map((item) => item.artifactId)).size ===
      message.attachments.length,
    "Attachment identities must be unique.",
  )
  .refine(
    (message) =>
      message.attachments.reduce((sum, item) => sum + item.size, 0) <= maximumGmailAttachmentBytes,
    "Attachments exceed the message limit.",
  );

export const gmailMessagePreparationSchema = z
  .strictObject({
    operationId: z.uuid(),
    preparedAt: z.iso.datetime(),
    target: resolvedTargetSchema.extend({
      operation: z.enum(["gmail.draft", "gmail.send"]),
      calendarId: z.null(),
    }),
    message: gmailOutgoingMessageSchema,
  })
  .refine(
    (input) => input.message.from.email.toLowerCase() === input.target.email.toLowerCase(),
    "Sender must match the selected Gmail account.",
  )
  .refine(
    (input) =>
      input.target.operation !== "gmail.send" ||
      input.message.to.length + input.message.cc.length + input.message.bcc.length > 0,
    "Sending requires at least one recipient.",
  )
  .refine(
    (input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 80_000,
    "Message content exceeds the review limit; use an attachment for larger content.",
  );
export const gmailPreparedMessageSchema = gmailMessagePreparationSchema.safeExtend({
  version: z.literal(1),
  messageId,
  mimeSize: z.number().int().positive().max(maximumGmailMimeBytes),
  mimeSha256: artifactMetadataSchema.shape.sha256,
});
export type GmailOutgoingMessage = z.infer<typeof gmailOutgoingMessageSchema>;
export type GmailMessagePreparation = z.infer<typeof gmailMessagePreparationSchema>;
export type GmailPreparedMessage = z.infer<typeof gmailPreparedMessageSchema>;
