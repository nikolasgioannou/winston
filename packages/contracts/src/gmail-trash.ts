import { z } from "zod";
import { resolvedTargetSchema } from "./connection-targets";
import { gmailIdSchema } from "./gmail";
import { gmailLabelMessageSnapshotSchema } from "./gmail-label-mutations";

export const gmailTrashIntentSchema = z.strictObject({
  kind: z.enum(["message.trash", "message.restore"]),
  accountId: z.uuid(),
  messageId: gmailIdSchema,
});
export const gmailTrashInputSchema = z.strictObject({
  key: z.string().min(1).max(100),
  intent: gmailTrashIntentSchema,
});
export const gmailTrashPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: gmailTrashIntentSchema.shape.kind,
  operationId: z.uuid(),
  target: resolvedTargetSchema.extend({
    operation: z.literal("gmail.trash"),
    calendarId: z.null(),
  }),
  message: gmailLabelMessageSnapshotSchema,
});
export type GmailTrashInput = z.infer<typeof gmailTrashInputSchema>;
export type GmailTrashIntent = z.infer<typeof gmailTrashIntentSchema>;
export type GmailTrashPlan = z.infer<typeof gmailTrashPlanSchema>;
