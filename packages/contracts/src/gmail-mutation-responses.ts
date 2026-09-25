import { z } from "zod";
import { gmailIdSchema } from "./gmail";

export const gmailDraftIdentitySchema = z.object({
  id: gmailIdSchema,
  message: z.object({ id: gmailIdSchema }),
});
export const gmailWriteMessageResponseSchema = z.object({
  id: gmailIdSchema,
  threadId: gmailIdSchema,
});
export const gmailWriteDraftResponseSchema = z.object({
  id: gmailIdSchema,
  message: gmailWriteMessageResponseSchema,
});
export const gmailMutationReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.enum(["draft.create", "draft.update", "message.send", "draft.send"]),
    draftId: gmailIdSchema.nullable(),
    messageId: gmailIdSchema,
    threadId: gmailIdSchema,
  })
  .refine((receipt) => JSON.stringify(receipt).length <= 1024);
