import type { TelegramUpdate } from "@winston/contracts/telegram";

export function telegramMedia(update: TelegramUpdate) {
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  const media = message.document ?? message.voice ?? message.audio ?? message.video;
  const photo = [...(message.photo ?? [])].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  )[0];
  const file = media ?? photo;
  if (!file) return null;
  return {
    fileId: file.file_id,
    identity: typeof file.file_unique_id === "string" ? file.file_unique_id : file.file_id,
    size:
      typeof file.file_size === "number" &&
      Number.isSafeInteger(file.file_size) &&
      file.file_size >= 0
        ? file.file_size
        : undefined,
    filename:
      media && typeof media.file_name === "string"
        ? media.file_name
        : message.voice
          ? "voice.ogg"
          : photo
            ? "photo.jpg"
            : "attachment",
    mediaType: media?.mime_type ?? (photo ? "image/jpeg" : "application/octet-stream"),
    voice: Boolean(message.voice),
  };
}
