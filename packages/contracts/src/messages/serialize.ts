import {
  autonomousEventSchema,
  userMessageSchema,
  type MessageMetadata,
  type UserMessage,
} from "./schema";
import { element, escapeXml } from "./xml";

function localTimestamp(snapshot: UserMessage["sentAt"]) {
  const [hours, minutes, seconds = 0] = snapshot.offset.slice(1).split(":").map(Number);
  const sign = snapshot.offset.startsWith("-") ? -1 : 1;
  const milliseconds = sign * ((hours ?? 0) * 3600 + (minutes ?? 0) * 60 + seconds) * 1000;
  const local = new Date(Date.parse(snapshot.instant) + milliseconds).toISOString();

  return local.replace(/Z$/, snapshot.offset);
}

function serializeMetadata(metadata: MessageMetadata) {
  const fragments = metadata.attachments.map((attachment) => {
    const { id, filename, mediaType, state } = attachment;
    const fields: Record<string, string> = { id, filename, media_type: mediaType, state };

    if (state === "staged") {
      Object.assign(fields, {
        artifact_id: attachment.artifactId,
        workspace_id: attachment.workspaceId,
        path: attachment.path,
        sha256: attachment.sha256,
        verified_at: attachment.verifiedAt,
      });
    }

    return element("attachment", fields, state === "failed" ? escapeXml(attachment.reason) : "");
  });
  const transcript = metadata.transcript;

  if (transcript) {
    const fields: Record<string, string> = {
      state: transcript.state,
      attachment_id: transcript.attachmentId,
      provenance: "machine-transcription",
    };

    if (transcript.state === "ready") {
      Object.assign(fields, {
        provider: transcript.provider,
        model: transcript.model,
        completed_at: transcript.completedAt,
      });
    }

    const text =
      transcript.state === "ready"
        ? transcript.text
        : transcript.state === "failed"
          ? transcript.reason
          : "";
    fragments.push(element("transcript", fields, escapeXml(text)));
  }

  for (const reference of metadata.references) {
    fragments.push(element("reference", reference));
  }

  return fragments.join("\n");
}

export function serializeUserMessage(input: unknown) {
  const message = userMessageSchema.parse(input);
  const timestamp = element(
    "sent_at",
    { timezone: message.sentAt.timezone },
    escapeXml(localTimestamp(message.sentAt)),
  );
  const provider = element("provider_timestamp", {
    sent_at: message.provider.sentAt,
    ...(message.provider.editedAt ? { edited_at: message.provider.editedAt } : {}),
  });
  const event = element(
    "system_event",
    { version: 1, id: message.eventId, message_id: message.messageId, revision: message.revision },
    [timestamp, provider, serializeMetadata(message.metadata)].filter(Boolean).join("\n"),
  );

  return element(
    "user_message",
    { id: message.messageId },
    `${element("user_content", { kind: message.input.kind }, escapeXml(message.input.text))}\n${event}`,
  );
}

// The caller selects the model role; autonomous work never fabricates user-authored content.
export function serializeAutonomousEvent(input: unknown) {
  const event = autonomousEventSchema.parse(input);

  return element(
    "system_event",
    { version: 1, id: event.eventId, trigger: event.trigger, reference_id: event.referenceId },
    [
      element(
        "occurred_at",
        { timezone: event.occurredAt.timezone },
        localTimestamp(event.occurredAt),
      ),
      element("detail", {}, escapeXml(event.detail)),
    ].join("\n"),
  );
}
