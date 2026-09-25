import type { ActionRecord } from "@winston/contracts/actions";
import { readGmailLabelMutationPlan } from "./gmail-label-mutation-plan";

function quote(value: string) {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function formatGmailLabelMutationApproval(action: ActionRecord) {
  const plan = readGmailLabelMutationPlan(action.request.arguments);
  const target = action.request.authorization.target;
  if (
    target.kind !== "connection" ||
    target.id !== plan.target.connectionId ||
    target.resource !== null ||
    action.request.authorization.operation !== "gmail.modify" ||
    action.operationId !== plan.operationId
  )
    throw new Error("Label review does not match its action.");
  const labels = (values: typeof plan.add) =>
    values.length
      ? values.map((label) => `${quote(label.name)} (${quote(label.id)})`).join(", ")
      : "None";
  return [
    "Approval needed",
    "Change Gmail message labels",
    `Account: ${quote(plan.target.email)}`,
    `Message: ${quote(plan.message.id)}`,
    `Add: ${labels(plan.add)}`,
    `Remove: ${labels(plan.remove)}`,
    "Applies to this message only. Removing INBOX archives it; removing UNREAD marks it read. Other labels are preserved.",
    `Expires: ${action.expiresAt}`,
  ].join("\n");
}
