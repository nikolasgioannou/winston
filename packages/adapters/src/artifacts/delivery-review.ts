import type { ActionRecord } from "@winston/contracts/actions";
import { fileDeliveryPlanSchema } from "@winston/contracts/artifacts";

function quote(value: string) {
  return JSON.stringify(value).replace(
    /[\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function formatFileDeliveryApproval(action: ActionRecord) {
  const { operation, target } = action.request.authorization;
  const parsed = fileDeliveryPlanSchema.safeParse(action.request.arguments);
  if (
    operation !== "workspace.file.read" ||
    target.kind !== "workspace" ||
    target.resource !== null ||
    !parsed.success ||
    parsed.data.workspaceId !== target.id
  )
    return null;
  const plan = parsed.data;
  return [
    "Send this file to your paired Telegram chat?",
    `File: ${quote(plan.name)}`,
    `Size: ${String(plan.size)} bytes (${quote(plan.mediaType)})`,
    `Artifact: ${plan.artifactId}`,
    `Recipient: Telegram chat ${plan.chatId}`,
    `Expires: ${action.expiresAt}`,
  ].join("\n");
}
