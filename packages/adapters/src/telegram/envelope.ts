import { randomUUID } from "node:crypto";
import { userMessageSchema, type UserMessage } from "@winston/contracts/messages";
import type { TelegramUpdate } from "@winston/contracts/telegram";
import { telegramMedia } from "./media";

// Called only with a durable, owner-authorized provider update and its original receipt snapshot.
export function telegramEnvelope(input: {
  update: TelegramUpdate;
  ownerId: string;
  conversationId: string;
  sentAt: UserMessage["sentAt"];
  current?: UserMessage;
  previousUpdate?: TelegramUpdate;
}): UserMessage {
  const message = input.update.message ?? input.update.edited_message;
  if (!message) throw new Error("Telegram update has no message.");

  const media = telegramMedia(input.update);
  const previousMedia = input.previousUpdate ? telegramMedia(input.previousUpdate) : null;
  const sameMedia =
    media !== null &&
    media.identity === previousMedia?.identity &&
    media.voice === previousMedia.voice;
  const previousAttachment = sameMedia ? input.current?.metadata.attachments[0] : undefined;
  const attachmentId = previousAttachment?.id ?? randomUUID();
  const attachments: UserMessage["metadata"]["attachments"] = media
    ? [
        previousAttachment ?? {
          id: attachmentId,
          state: "pending",
          filename: media.filename,
          mediaType: media.mediaType,
        },
      ]
    : [];

  return userMessageSchema.parse({
    version: 1,
    kind: "user-message",
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    messageId: input.current?.messageId ?? randomUUID(),
    eventId: randomUUID(),
    revision: input.current ? input.current.revision + 1 : 0,
    sentAt: input.current?.sentAt ?? input.sentAt,
    provider: {
      name: "telegram",
      messageId: `${String(message.chat.id)}:${String(message.message_id)}`,
      sentAt: new Date(message.date * 1000).toISOString(),
      ...(message.edit_date === undefined
        ? {}
        : { editedAt: new Date(message.edit_date * 1000).toISOString() }),
    },
    input: {
      kind: message.voice
        ? "voice"
        : message.text !== undefined
          ? "text"
          : message.caption !== undefined
            ? "caption"
            : "attachment",
      text: message.text ?? message.caption ?? "",
    },
    metadata: {
      attachments,
      ...(message.voice
        ? {
            transcript:
              sameMedia && input.current?.metadata.transcript
                ? input.current.metadata.transcript
                : { state: "pending", attachmentId },
          }
        : {}),
      references: input.current?.metadata.references ?? [],
    },
  });
}
