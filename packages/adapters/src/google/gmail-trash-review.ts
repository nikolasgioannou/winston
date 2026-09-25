import type { ActionRecord } from "@winston/contracts/actions";
import { readGmailTrashPlan } from "./gmail-trash-plan";

export function formatGmailTrashApproval(action: ActionRecord) {
  const plan = readGmailTrashPlan(action.request.arguments);
  const target = action.request.authorization.target;
  if (
    target.kind !== "connection" ||
    target.id !== plan.target.connectionId ||
    target.resource !== null ||
    action.request.authorization.operation !== "gmail.trash" ||
    action.operationId !== plan.operationId
  )
    throw new Error("Trash review does not match its action.");
  return [
    "Approval needed",
    plan.kind === "message.trash"
      ? "Move Gmail message to Trash"
      : "Restore Gmail message from Trash",
    `Account: ${JSON.stringify(plan.target.email)}`,
    `Message: ${JSON.stringify(plan.message.id)}`,
    plan.kind === "message.trash"
      ? "This moves only this message to Trash. It does not permanently delete it. Gmail's normal Trash retention applies."
      : "This removes only this message from Trash. It does not request a specific destination folder.",
    `Expires: ${action.expiresAt}`,
  ].join("\n");
}
