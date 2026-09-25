import { gmailDraftPageSchema, gmailListPageSchema } from "@winston/contracts/gmail";
import {
  gmailProviderEvidenceSchema,
  gmailRawMessageSchema,
  gmailRawDraftSchema,
} from "@winston/contracts/gmail-reconciliation";
import type { GmailMutationPlan } from "@winston/contracts/gmail-mutations";
import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import type { createArtifactReader } from "../artifacts";
import { createGoogleReadRequest, GoogleReadError, type GoogleReadOptions } from "./read-request";
import { readGmailOutgoingAttachments } from "./gmail-outgoing-attachments";
import { rebuildGmailMessage } from "./gmail-message-preparation";
import { gmailMutationMimeMatches } from "./gmail-reconciliation-evidence";

type Options = GoogleReadOptions & { artifacts: ReturnType<typeof createArtifactReader> };

export async function observeGmailMutation(
  options: Options,
  ownerId: string,
  plan: GmailMutationPlan,
  target: ResolvedTarget,
  signal: AbortSignal,
) {
  const request = createGoogleReadRequest(options, {
    service: "gmail",
    error: (kind) => new GoogleReadError(kind, "Gmail"),
  });
  const prepared = plan.prepared;
  const unknown = () =>
    gmailProviderEvidenceSchema.parse({
      source: target,
      operationId: prepared.operationId,
      matched: false,
      receipt: null,
    });
  const contents = await readGmailOutgoingAttachments(
    options.artifacts,
    ownerId,
    prepared.message.attachments,
    signal,
  );
  const expected = await rebuildGmailMessage(prepared, contents);
  const sending = plan.kind.endsWith("send");
  let draftId = plan.draft?.id ?? null;
  let messageId: string | undefined;
  const query = `rfc822msgid:${prepared.messageId}`;
  if (sending) {
    const found = await request(
      ownerId,
      target,
      "messages",
      new URLSearchParams({
        q: query,
        labelIds: "SENT",
        maxResults: "2",
        includeSpamTrash: "true",
      }),
      signal,
    );
    const page = gmailListPageSchema.parse(found.data);
    if (page.nextPageToken || page.messages.length !== 1) return unknown();
    messageId = page.messages[0]?.id;
  } else if (!draftId) {
    const found = await request(
      ownerId,
      target,
      "drafts",
      new URLSearchParams({
        q: query,
        maxResults: "2",
        includeSpamTrash: "true",
      }),
      signal,
    );
    const page = gmailDraftPageSchema.parse(found.data);
    if (page.nextPageToken || page.drafts.length !== 1) return unknown();
    draftId = page.drafts[0]?.id ?? null;
  }
  if (sending ? !messageId : !draftId) return unknown();
  const found = await request(
    ownerId,
    target,
    sending
      ? `messages/${encodeURIComponent(messageId ?? "")}`
      : `drafts/${encodeURIComponent(draftId ?? "")}`,
    new URLSearchParams({ format: "raw" }),
    signal,
  );
  const draft = sending ? null : gmailRawDraftSchema.parse(found.data);
  const message = draft ? draft.message : gmailRawMessageSchema.parse(found.data);
  if (
    sending ? message.id !== messageId || !message.labelIds.includes("SENT") : draft?.id !== draftId
  )
    return unknown();
  if (prepared.message.reply && message.threadId !== prepared.message.reply.threadId)
    return unknown();
  const actual = Buffer.from(message.raw, "base64url");
  if (
    actual.toString("base64url") !== message.raw.replace(/=+$/, "") ||
    !(await gmailMutationMimeMatches(expected, actual))
  )
    return unknown();
  return gmailProviderEvidenceSchema.parse({
    source: target,
    operationId: prepared.operationId,
    matched: true,
    receipt: {
      version: 1,
      kind: plan.kind,
      draftId,
      messageId: message.id,
      threadId: message.threadId,
    },
  });
}
