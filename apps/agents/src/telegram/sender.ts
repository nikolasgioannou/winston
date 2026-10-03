import { InputFile, type Api } from "grammy";
import type { Message } from "grammy/types";

/** A file to upload: as a photo (compressed, shown inline) or a document (sent as is). */
export interface OutgoingFile {
  kind: "photo" | "document";
  name: string;
  bytes: Uint8Array;
}

/** An uploaded file: its message, and the id Telegram stores it under. */
export interface SentFile {
  messageId: number;
  fileId: string;
}

/** The Telegram calls the agents make. */
export interface TelegramSender {
  /** Plain text: no parse mode, nothing to escape. */
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  /** A Rich Message from standard Markdown (Bot API 10.1). */
  sendRichMessage(
    chatId: number,
    markdown: string,
  ): Promise<{ message_id: number }>;
  /**
   * A passing status as a Rich Message draft (Bot API 10.3, private chats):
   * a temporary preview that updates in place under one `draftId`, fades
   * after about 30 s, and goes when the next message arrives.
   */
  sendRichMessageDraft(
    chatId: number,
    draftId: number,
    markdown: string,
  ): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
  /**
   * Uploads 1–10 files of one kind: one file as its own message, several as
   * a media group (an album). Returns them in order.
   */
  sendFiles(
    chatId: number,
    files: readonly OutgoingFile[],
  ): Promise<SentFile[]>;
}

/**
 * The real sender over grammY. grammY 1.46 doesn't type `sendRichMessage`
 * or `sendRichMessageDraft` yet, so they go through the raw API, which
 * passes any method name on.
 */
export function grammySender(api: Api): TelegramSender {
  const raw = api.raw as unknown as Record<
    string,
    (payload: Record<string, unknown>) => Promise<{ message_id: number }>
  >;
  return {
    sendMessage: (chatId, text) => api.sendMessage(chatId, text),
    sendRichMessage: (chatId, markdown) => {
      const send = raw.sendRichMessage;
      if (!send) throw new Error("grammY's raw API has no sendRichMessage");
      return send({ chat_id: chatId, rich_message: { markdown } });
    },
    sendRichMessageDraft: (chatId, draftId, markdown) => {
      const send = raw.sendRichMessageDraft;
      if (!send)
        throw new Error("grammY's raw API has no sendRichMessageDraft");
      return send({
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { markdown },
      });
    },
    sendChatAction: (chatId, action) => api.sendChatAction(chatId, action),
    async sendFiles(chatId, files) {
      const input = (file: OutgoingFile) =>
        new InputFile(file.bytes, file.name);
      const [only] = files;
      if (files.length === 1 && only) {
        const message =
          only.kind === "photo"
            ? await api.sendPhoto(chatId, input(only))
            : await api.sendDocument(chatId, input(only));
        return [sentFile(message)];
      }
      const kind = only?.kind ?? "document";
      const messages =
        kind === "photo"
          ? await api.sendMediaGroup(
              chatId,
              files.map((file) => ({
                type: "photo" as const,
                media: input(file),
              })),
            )
          : await api.sendMediaGroup(
              chatId,
              files.map((file) => ({
                type: "document" as const,
                media: input(file),
              })),
            );
      return messages.map(sentFile);
    },
  };
}

/** A photo's largest size, or the document, as Telegram stored it. */
function sentFile(message: Message): SentFile {
  const fileId =
    message.photo?.at(-1)?.file_id ?? message.document?.file_id ?? "";
  return { messageId: message.message_id, fileId };
}
