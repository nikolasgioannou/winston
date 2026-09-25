import { z } from "zod";
import { gmailLabelMutationIntentSchema } from "./gmail-label-mutations";

export const cliGmailLabelMutationRequestSchema = z
  .strictObject({
    version: z.literal(1),
    command: z.literal("gmail.modify"),
    key: z.string().min(1).max(100),
    ...gmailLabelMutationIntentSchema.shape,
  })
  .refine(
    (value) =>
      gmailLabelMutationIntentSchema.safeParse({
        accountId: value.accountId,
        messageId: value.messageId,
        addLabelIds: value.addLabelIds,
        removeLabelIds: value.removeLabelIds,
      }).success,
    "Provide a nonempty, nonconflicting label change.",
  );
