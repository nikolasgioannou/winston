import { z } from "zod";
import { resolvedTargetSchema } from "./connection-targets";
import {
  gmailIdSchema,
  gmailLabelIdsSchema,
  gmailLabelSchema,
  gmailReadTargetSchema,
} from "./gmail";

const mutableIds = gmailLabelIdsSchema.refine(
  (ids) => ids.length <= 100 && !ids.some((id) => ["TRASH", "SENT", "DRAFT"].includes(id)),
  "Provider-managed and trash labels need a different operation.",
);
export const gmailLabelMutationIntentSchema = z
  .strictObject({
    accountId: z.uuid(),
    messageId: gmailIdSchema,
    addLabelIds: mutableIds,
    removeLabelIds: mutableIds,
  })
  .refine(
    (input) =>
      input.addLabelIds.length + input.removeLabelIds.length > 0 &&
      !input.addLabelIds.some((id) => input.removeLabelIds.includes(id)),
    "Provide a nonempty, nonconflicting label change.",
  );
export const gmailLabelMutationInputSchema = z.strictObject({
  key: z.string().min(1).max(100),
  intent: gmailLabelMutationIntentSchema,
});
export const gmailLabelMessageSnapshotSchema = z.object({
  source: gmailReadTargetSchema,
  trust: z.literal("untrusted_external_content"),
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  labelIds: gmailLabelIdsSchema,
});
export const gmailLabelInventorySnapshotSchema = z.object({
  source: gmailReadTargetSchema,
  trust: z.literal("untrusted_external_content"),
  labels: z
    .array(gmailLabelSchema)
    .max(10_000)
    .refine((labels) => new Set(labels.map((label) => label.id)).size === labels.length),
});
export const gmailLabelMutationPlanSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("labels.modify"),
  operationId: z.uuid(),
  target: resolvedTargetSchema.extend({
    operation: z.literal("gmail.modify"),
    calendarId: z.null(),
  }),
  message: gmailLabelMessageSnapshotSchema,
  add: z.array(gmailLabelSchema).max(100),
  remove: z.array(gmailLabelSchema).max(100),
});
export const gmailLabelWriteResponseSchema = z.object({
  id: gmailIdSchema,
  threadId: gmailIdSchema,
  labelIds: gmailLabelIdsSchema,
});
export type GmailLabelMutationInput = z.infer<typeof gmailLabelMutationInputSchema>;
export type GmailLabelMutationIntent = z.infer<typeof gmailLabelMutationIntentSchema>;
export type GmailLabelMutationPlan = z.infer<typeof gmailLabelMutationPlanSchema>;
