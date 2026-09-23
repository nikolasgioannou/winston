import { z } from "zod";
import { resolvedTargetSchema } from "./connection-targets";

export const gmailIdSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/);
export const gmailReadTargetSchema = resolvedTargetSchema.extend({
  operation: z.literal("gmail.read"),
  calendarId: z.null(),
});
export const gmailSearchSchema = z.strictObject({
  target: gmailReadTargetSchema,
  query: z.string().max(2000),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z
    .strictObject({
      connectionId: z.uuid(),
      query: z.string().max(2000),
      pageToken: z.string().min(1).max(4096),
    })
    .optional(),
});
export const gmailMessageRequestSchema = z.strictObject({
  target: gmailReadTargetSchema,
  id: gmailIdSchema,
});
export const gmailAttachmentRequestSchema = gmailMessageRequestSchema.extend({
  partId: z.string().max(256),
});
export const gmailListPageSchema = z.object({
  messages: z
    .array(z.object({ id: gmailIdSchema, threadId: gmailIdSchema }))
    .max(100)
    .default([]),
  nextPageToken: z.string().max(4096).optional(),
});
export const gmailPartBodySchema = z.object({
  attachmentId: gmailIdSchema.optional(),
  size: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024),
  data: z
    .string()
    .max(36 * 1024 * 1024)
    .optional(),
});
export const gmailPartSchema = z.object({
  partId: z.string().max(256),
  mimeType: z.string().min(1).max(200),
  filename: z.string().max(4096).default(""),
  headers: z
    .array(z.object({ name: z.string().max(256), value: z.string().max(16384) }))
    .max(500)
    .default([]),
  body: gmailPartBodySchema,
  parts: z.array(z.unknown()).max(1000).default([]),
});
export const gmailMessageSchema = z.object({
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  snippet: z.string().max(16384).default(""),
  internalDate: z
    .string()
    .regex(/^\d{1,16}$/)
    .optional(),
  payload: z.unknown(),
});
export const gmailThreadSchema = z.object({
  id: gmailIdSchema,
  messages: z.array(gmailMessageSchema).max(1000).default([]),
});
export type GmailMessageRequest = z.input<typeof gmailMessageRequestSchema>;
export type GmailSearch = z.input<typeof gmailSearchSchema>;
export type GmailAttachmentRequest = z.input<typeof gmailAttachmentRequestSchema>;
export type GmailPart = z.infer<typeof gmailPartSchema>;
