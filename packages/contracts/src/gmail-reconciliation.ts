import { z } from "zod";
import { gmailReadTargetSchema, gmailIdSchema } from "./gmail";
import { maximumGmailMimeBytes } from "./gmail-messages";
import { cliReadRequestSchema } from "./cli-reads";
import { gmailMutationReceiptSchema } from "./gmail-mutation-responses";

// Internal server request. The operation supplies the immutable comparison content.
export const gmailReconciliationReadSchema = z.strictObject({
  version: z.literal(1),
  command: z.literal("gmail.mutation-evidence"),
  accountId: z.uuid(),
  id: z.uuid(),
  key: z.string().min(1).max(100),
});
export type GmailReconciliationRead = z.infer<typeof gmailReconciliationReadSchema>;
export const connectedReadRequestSchema = z.union([
  cliReadRequestSchema,
  gmailReconciliationReadSchema,
]);
export const gmailRawMessageSchema = z.object({
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  raw: z
    .string()
    .max(Math.ceil(maximumGmailMimeBytes / 3) * 4)
    .regex(/^[A-Za-z0-9_-]*={0,2}$/),
  labelIds: z.array(z.string()).max(1000).default([]),
});
export const gmailRawDraftSchema = z.object({ id: gmailIdSchema, message: gmailRawMessageSchema });
export const gmailProviderEvidenceSchema = z.strictObject({
  source: gmailReadTargetSchema,
  operationId: z.uuid(),
  matched: z.boolean(),
  receipt: gmailMutationReceiptSchema.nullable(),
});
export const gmailReconciliationEvidenceSchema = gmailProviderEvidenceSchema.extend({
  readActionId: z.uuid(),
});
