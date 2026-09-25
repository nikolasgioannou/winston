import {
  gmailTrashIntentSchema,
  gmailTrashPlanSchema,
  type GmailTrashPlan,
  type GmailTrashIntent,
} from "@winston/contracts/gmail-trash";
import { canonicalJson } from "@winston/contracts/json";

export function gmailTrashIntent(plan: GmailTrashPlan): GmailTrashIntent {
  return { kind: plan.kind, accountId: plan.target.connectionId, messageId: plan.message.id };
}
export function gmailTrashStateMatches(plan: GmailTrashPlan, labels: string[]) {
  return !labels.includes("DRAFT") && labels.includes("TRASH") === (plan.kind === "message.trash");
}
export function readGmailTrashPlan(input: unknown) {
  const plan = gmailTrashPlanSchema.parse(input);
  if (
    canonicalJson({ ...plan.message.source, operation: "gmail.trash" }) !==
    canonicalJson(plan.target)
  )
    throw new Error("Gmail message source does not match the selected account.");
  if (
    plan.message.labelIds.includes("DRAFT") ||
    gmailTrashStateMatches(plan, plan.message.labelIds)
  )
    throw new Error("The message is a draft or already has the requested trash state.");
  return plan;
}
export function prepareGmailTrash(
  operationId: string,
  target: GmailTrashPlan["target"],
  input: GmailTrashIntent,
  message: unknown,
) {
  const intent = gmailTrashIntentSchema.parse(input);
  const plan = readGmailTrashPlan({ version: 1, operationId, kind: intent.kind, target, message });
  if (intent.accountId !== target.connectionId || intent.messageId !== plan.message.id)
    throw new Error("Gmail trash intent does not match its source.");
  return plan;
}
