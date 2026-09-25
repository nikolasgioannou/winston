import { gmailTrashIntentSchema } from "@winston/contracts/gmail-trash";
import { readGmailTrashPlan, gmailTrashIntent } from "../google/gmail-trash-plan";
import type { DatabaseTransaction } from "./owners";
import { gmailStateActionRepository } from "./gmail-state-actions";

export function gmailTrashActionRepository(transaction: DatabaseTransaction, ownerId: string) {
  return gmailStateActionRepository(transaction, ownerId, {
    prefix: "gmail-trash",
    parseIntent: (input) => gmailTrashIntentSchema.parse(input),
    readPlan: readGmailTrashPlan,
    intent: gmailTrashIntent,
  });
}
