import {
  gmailLabelMutationIntentSchema,
  gmailLabelMutationPlanSchema,
  gmailLabelMessageSnapshotSchema,
  gmailLabelInventorySnapshotSchema,
  type GmailLabelMutationIntent,
  type GmailLabelMutationPlan,
} from "@winston/contracts/gmail-label-mutations";
import { canonicalJson } from "@winston/contracts/json";

const systemLabels = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SPAM",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
export function gmailLabelMutationIntent(plan: GmailLabelMutationPlan): GmailLabelMutationIntent {
  return gmailLabelMutationIntentSchema.parse({
    accountId: plan.target.connectionId,
    messageId: plan.message.id,
    addLabelIds: plan.add.map((label) => label.id),
    removeLabelIds: plan.remove.map((label) => label.id),
  });
}
export function readGmailLabelMutationPlan(input: unknown) {
  const plan = gmailLabelMutationPlanSchema.parse(input);
  gmailLabelMutationIntent(plan);
  if (plan.message.labelIds.some((id) => id === "DRAFT" || id === "TRASH"))
    throw new Error("Draft or trashed messages require a different operation.");
  if (
    canonicalJson({ ...plan.message.source, operation: "gmail.modify" }) !==
    canonicalJson(plan.target)
  )
    throw new Error("Message source does not match the selected account.");
  for (const label of [...plan.add, ...plan.remove]) {
    if (label.type === "system" && !systemLabels.has(label.id))
      throw new Error("This system label is not writable.");
  }
  return plan;
}
export function prepareGmailLabelMutation(
  operationId: string,
  target: GmailLabelMutationPlan["target"],
  inputIntent: GmailLabelMutationIntent,
  inputMessage: unknown,
  inputInventory: unknown,
) {
  const intent = gmailLabelMutationIntentSchema.parse(inputIntent);
  const message = gmailLabelMessageSnapshotSchema.parse(inputMessage);
  const inventory = gmailLabelInventorySnapshotSchema.parse(inputInventory);
  if (
    intent.accountId !== target.connectionId ||
    intent.messageId !== message.id ||
    canonicalJson(inventory.source) !== canonicalJson(message.source)
  )
    throw new Error("Gmail label sources do not match.");
  const find = (id: string) => {
    const label = inventory.labels.find((candidate) => candidate.id === id);
    if (!label) throw new Error("Selected label no longer exists.");
    return label;
  };
  return readGmailLabelMutationPlan({
    version: 1,
    kind: "labels.modify",
    operationId,
    target,
    message,
    add: intent.addLabelIds.map(find),
    remove: intent.removeLabelIds.map(find),
  });
}

export function gmailLabelsMatch(plan: GmailLabelMutationPlan, labels: string[]) {
  return (
    plan.add.every((label) => labels.includes(label.id)) &&
    plan.remove.every((label) => !labels.includes(label.id))
  );
}
