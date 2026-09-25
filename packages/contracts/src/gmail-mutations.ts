import { z } from "zod";
import { gmailIdSchema, gmailReadTargetSchema } from "./gmail";
import { gmailOutgoingMessageSchema, gmailPreparedMessageSchema } from "./gmail-messages";

const common = { accountId: z.uuid(), message: gmailOutgoingMessageSchema };
const existing = { draftId: gmailIdSchema, expectedMessageId: gmailIdSchema };
export const gmailMutationIntentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("draft.create") }),
  z.strictObject({ ...common, ...existing, kind: z.literal("draft.update") }),
  z.strictObject({ ...common, kind: z.literal("message.send") }),
  z.strictObject({ ...common, ...existing, kind: z.literal("draft.send") }),
]);
export const gmailDraftVersionSchema = z.strictObject({
  source: gmailReadTargetSchema,
  id: gmailIdSchema,
  messageId: gmailIdSchema,
});
export const gmailReplySourceSchema = z.strictObject({
  source: gmailReadTargetSchema,
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  messageId: z.string().min(1).max(998),
  subject: z.string().max(2000),
});
export const gmailMutationPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["draft.create", "draft.update", "message.send", "draft.send"]),
  prepared: gmailPreparedMessageSchema,
  draft: gmailDraftVersionSchema.nullable(),
  replySource: gmailReplySourceSchema.nullable(),
  method: z.enum(["POST", "PUT"]),
  path: z.string().min(1).max(4096),
});
export type GmailMutationIntent = z.infer<typeof gmailMutationIntentSchema>;
export type GmailMutationPlan = z.infer<typeof gmailMutationPlanSchema>;
export type GmailDraftVersion = z.infer<typeof gmailDraftVersionSchema>;
export type GmailReplySource = z.infer<typeof gmailReplySourceSchema>;
