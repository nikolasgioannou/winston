import {
  gmailMutationIntentSchema,
  gmailMutationPlanSchema,
  gmailDraftVersionSchema,
  gmailReplySourceSchema,
  type GmailMutationIntent,
  type GmailMutationPlan,
  type GmailDraftVersion,
  type GmailReplySource,
} from "@winston/contracts/gmail-mutations";
import type { GmailPreparedMessage } from "@winston/contracts/gmail-messages";
import { canonicalJson } from "@winston/contracts/json";
import {
  prepareGmailMessage,
  rebuildGmailMessage,
  type GmailAttachmentBytes,
} from "./gmail-message-preparation";

type Preparation = {
  operationId: string;
  preparedAt: string;
  target: GmailPreparedMessage["target"];
  intent: GmailMutationIntent;
  draft?: GmailDraftVersion;
  replySource?: GmailReplySource;
};

function sameSource(source: GmailDraftVersion["source"], target: Preparation["target"]) {
  return canonicalJson({ ...source, operation: target.operation }) === canonicalJson(target);
}

function expectedPlan(input: Preparation, prepared: GmailPreparedMessage): GmailMutationPlan {
  const intent = gmailMutationIntentSchema.parse(input.intent);
  const { target } = input;
  const operation = intent.kind.endsWith("send") ? "gmail.send" : "gmail.draft";
  if (target.connectionId !== intent.accountId || target.operation !== operation)
    throw new Error("Gmail mutation does not match the selected account or permission.");
  let draft: GmailDraftVersion | null = null;
  if ("draftId" in intent) {
    draft = gmailDraftVersionSchema.parse(input.draft);
    if (
      !sameSource(draft.source, target) ||
      draft.id !== intent.draftId ||
      draft.messageId !== intent.expectedMessageId
    )
      throw new Error("Gmail draft version changed or belongs to another account.");
  } else if (input.draft !== undefined) {
    throw new Error("A new Gmail message cannot consume an existing draft.");
  }
  let replySource: GmailReplySource | null = null;
  if (intent.message.reply) {
    replySource = gmailReplySourceSchema.parse(input.replySource);
    const reply = intent.message.reply;
    const subject = (value: string) => value.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
    if (
      !sameSource(replySource.source, target) ||
      replySource.id !== reply.sourceMessageId ||
      replySource.threadId !== reply.threadId ||
      replySource.messageId !== reply.inReplyTo ||
      subject(replySource.subject) !== subject(intent.message.subject)
    )
      throw new Error("Gmail reply does not match its source message and thread.");
  } else if (input.replySource !== undefined) {
    throw new Error("A non-reply cannot consume reply context.");
  }
  const path =
    intent.kind === "draft.create"
      ? "drafts"
      : intent.kind === "draft.update"
        ? `drafts/${encodeURIComponent(intent.draftId)}`
        : intent.kind === "draft.send"
          ? "drafts/send"
          : "messages/send";
  const plan = gmailMutationPlanSchema.parse({
    version: 1,
    kind: intent.kind,
    prepared,
    draft,
    replySource,
    method: intent.kind === "draft.update" ? "PUT" : "POST",
    path,
  });
  if (Buffer.byteLength(JSON.stringify(plan)) > 100_000)
    throw new Error("Gmail mutation exceeds the action review limit.");
  return plan;
}

// Preparation never authorizes a write. Draft versions detect known stale input;
// Gmail does not document an atomic version precondition for update/send.
export async function prepareGmailMutation(input: Preparation, contents: GmailAttachmentBytes[]) {
  const captured = structuredClone(input);
  const intent = gmailMutationIntentSchema.parse(captured.intent);
  const result = await prepareGmailMessage(
    {
      operationId: captured.operationId,
      preparedAt: captured.preparedAt,
      target: captured.target,
      message: intent.message,
    },
    contents,
  );
  return { plan: expectedPlan({ ...captured, intent }, result.plan), raw: result.raw };
}

export function gmailMutationIntent(input: GmailMutationPlan): GmailMutationIntent {
  const plan = gmailMutationPlanSchema.parse(input);
  return gmailMutationIntentSchema.parse({
    kind: plan.kind,
    accountId: plan.prepared.target.connectionId,
    message: plan.prepared.message,
    ...(plan.draft ? { draftId: plan.draft.id, expectedMessageId: plan.draft.messageId } : {}),
  });
}

export function readGmailMutationPlan(input: unknown) {
  const plan = gmailMutationPlanSchema.parse(input);
  const rebuilt = expectedPlan(
    {
      operationId: plan.prepared.operationId,
      preparedAt: plan.prepared.preparedAt,
      target: plan.prepared.target,
      intent: gmailMutationIntent(plan),
      ...(plan.draft ? { draft: plan.draft } : {}),
      ...(plan.replySource ? { replySource: plan.replySource } : {}),
    },
    plan.prepared,
  );
  if (canonicalJson(rebuilt) !== canonicalJson(plan))
    throw new Error("Gmail plan does not match its reviewed operation.");
  return plan;
}

export async function rebuildGmailMutation(input: unknown, contents: GmailAttachmentBytes[]) {
  const plan = readGmailMutationPlan(input);
  const raw = await rebuildGmailMessage(plan.prepared, contents);
  const message = {
    raw: raw.toString("base64url"),
    ...(plan.prepared.message.reply ? { threadId: plan.prepared.message.reply.threadId } : {}),
  };
  // Supply the reviewed raw content even for draft.send: never send unseen mutable draft content.
  const body =
    plan.kind === "message.send"
      ? message
      : {
          ...(plan.draft ? { id: plan.draft.id } : {}),
          message,
        };
  return { plan, body };
}
