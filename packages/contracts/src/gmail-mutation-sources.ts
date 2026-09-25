import { z } from "zod";
import { gmailIdSchema, gmailPartSchema, gmailReadTargetSchema } from "./gmail";

export const gmailDraftInspectionSchema = z.object({
  source: gmailReadTargetSchema,
  trust: z.literal("untrusted_external_content"),
  id: gmailIdSchema,
  message: z.object({ id: gmailIdSchema }),
});
export const gmailReplyInspectionSchema = z.object({
  source: gmailReadTargetSchema,
  trust: z.literal("untrusted_external_content"),
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  headers: gmailPartSchema.shape.headers,
});
