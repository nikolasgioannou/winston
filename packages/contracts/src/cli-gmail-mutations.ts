import { z } from "zod";
import { gmailMutationIntentSchema } from "./gmail-mutations";

const common = { version: z.literal(1), key: z.string().min(1).max(100) };
export const cliGmailReconciliationRequestSchema = z.strictObject({
  ...common,
  command: z.literal("gmail.reconcile"),
  id: z.uuid(),
});
export type CliGmailReconciliationRequest = z.infer<typeof cliGmailReconciliationRequestSchema>;
export const cliGmailMutationRequestSchema = z.discriminatedUnion("command", [
  gmailMutationIntentSchema.options[0]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("gmail.draft-create") }),
  gmailMutationIntentSchema.options[1]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("gmail.draft-update") }),
  gmailMutationIntentSchema.options[2]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("gmail.send") }),
  gmailMutationIntentSchema.options[3]
    .omit({ kind: true })
    .extend({ ...common, command: z.literal("gmail.draft-send") }),
]);
export type CliGmailMutationRequest = z.infer<typeof cliGmailMutationRequestSchema>;

export function gmailMutationInputFromCli(input: CliGmailMutationRequest) {
  const request = cliGmailMutationRequestSchema.parse(input);
  const kinds = {
    "gmail.draft-create": "draft.create",
    "gmail.draft-update": "draft.update",
    "gmail.send": "message.send",
    "gmail.draft-send": "draft.send",
  } as const;
  return {
    key: request.key,
    intent: gmailMutationIntentSchema.parse({
      accountId: request.accountId,
      message: request.message,
      kind: kinds[request.command],
      ...("draftId" in request
        ? { draftId: request.draftId, expectedMessageId: request.expectedMessageId }
        : {}),
    }),
  };
}
