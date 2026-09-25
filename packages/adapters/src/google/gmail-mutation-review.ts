import type { ActionRecord } from "@winston/contracts/actions";
import type { GmailOutgoingMessage } from "@winston/contracts/gmail-messages";
import { readGmailMutationPlan } from "./gmail-mutation-plan";

function quote(value: string) {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function addresses(value: GmailOutgoingMessage["to"]) {
  return value.length
    ? value
        .map(
          (mailbox) => `${quote(mailbox.email)}${mailbox.name ? ` (${quote(mailbox.name)})` : ""}`,
        )
        .join(", ")
    : "None";
}

export function formatGmailMutationApproval(action: ActionRecord) {
  const plan = readGmailMutationPlan(action.request.arguments);
  const prepared = plan.prepared;
  const message = prepared.message;
  const target = action.request.authorization.target;
  if (
    target.kind !== "connection" ||
    target.id !== prepared.target.connectionId ||
    target.resource !== null ||
    action.request.authorization.operation !== prepared.target.operation ||
    action.operationId !== prepared.operationId
  )
    throw new Error("Gmail review does not match its action.");
  const titles = {
    "draft.create": "Create Gmail draft",
    "draft.update": "Replace Gmail draft",
    "message.send": "Send Gmail message",
    "draft.send": "Send Gmail draft using this content",
  };
  const lines = [
    "Approval needed",
    titles[plan.kind],
    `Account: ${quote(prepared.target.email)}`,
    `From: ${addresses([message.from])}`,
    `To: ${addresses(message.to)}`,
    `Cc: ${addresses(message.cc)}`,
    `Bcc: ${addresses(message.bcc)}`,
    `Subject: ${quote(message.subject)}`,
    "",
    `Text: ${quote(message.text)}`,
  ];
  if (message.html !== null) lines.push("", `HTML source: ${quote(message.html)}`);
  if (message.reply)
    lines.push(
      "",
      `Reply to: ${quote(message.reply.sourceMessageId)}`,
      `Thread: ${quote(message.reply.threadId)}`,
    );
  lines.push(
    "",
    "Attachments:",
    ...(message.attachments.length
      ? message.attachments.map(
          (attachment) =>
            `• ${quote(attachment.name)} · ${String(attachment.size)} bytes · ${quote(attachment.mediaType)}\n  SHA-256: ${attachment.sha256}`,
        )
      : ["None"]),
  );
  if (plan.draft)
    lines.push(
      "",
      `Draft: ${quote(plan.draft.id)}`,
      `Reviewed version: ${quote(plan.draft.messageId)}`,
      "This replaces the draft's full content. A version check runs immediately before writing, but Gmail cannot prevent a simultaneous edit from being overwritten.",
    );
  if (plan.kind === "draft.send") lines.push("Gmail removes the draft after sending.");
  if (plan.kind.endsWith("send"))
    lines.push(
      "",
      "This sends the content and attachments shown above to all To, Cc and Bcc recipients.",
    );
  lines.push(`Expires: ${action.expiresAt}`);
  return lines.join("\n");
}
