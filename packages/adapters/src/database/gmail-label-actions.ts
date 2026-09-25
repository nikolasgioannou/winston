import { gmailLabelMutationIntentSchema } from "@winston/contracts/gmail-label-mutations";
import {
  readGmailLabelMutationPlan,
  gmailLabelMutationIntent,
} from "../google/gmail-label-mutation-plan";
import type { DatabaseTransaction } from "./owners";
import { gmailStateActionRepository } from "./gmail-state-actions";

export function gmailLabelActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  return gmailStateActionRepository(transaction, ownerId, {
    prefix: "gmail-label",
    parseIntent: (input) => gmailLabelMutationIntentSchema.parse(input),
    readPlan: readGmailLabelMutationPlan,
    intent: gmailLabelMutationIntent,
  });
}
