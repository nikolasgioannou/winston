import { gmailProviderEvidenceSchema } from "@winston/contracts/gmail-reconciliation";
import { gmailLabelWriteResponseSchema } from "@winston/contracts/gmail-label-mutations";
import type { GmailTrashPlan } from "@winston/contracts/gmail-trash";
import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import { createGoogleReadRequest, GoogleReadError, type GoogleReadOptions } from "./read-request";
import { gmailTrashStateMatches } from "./gmail-trash-plan";

export async function observeGmailTrash(
  options: GoogleReadOptions,
  ownerId: string,
  plan: GmailTrashPlan,
  target: ResolvedTarget,
  signal: AbortSignal,
) {
  const request = createGoogleReadRequest(options, {
    service: "gmail",
    error: (kind) => new GoogleReadError(kind, "Gmail"),
  });
  const found = await request(
    ownerId,
    target,
    `messages/${encodeURIComponent(plan.message.id)}`,
    new URLSearchParams({ format: "minimal", fields: "id,threadId,labelIds" }),
    signal,
  );
  const message = gmailLabelWriteResponseSchema.parse(found.data);
  const matched =
    message.id === plan.message.id &&
    message.threadId === plan.message.threadId &&
    gmailTrashStateMatches(plan, message.labelIds);
  return gmailProviderEvidenceSchema.parse({
    source: target,
    operationId: plan.operationId,
    matched,
    receipt: matched
      ? { version: 1, kind: plan.kind, messageId: message.id, threadId: message.threadId }
      : null,
  });
}
