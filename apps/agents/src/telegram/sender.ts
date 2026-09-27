import type { Api } from "grammy";

/** The Telegram calls the agents make. */
export interface TelegramSender {
  /** Plain text: no parse mode, nothing to escape. */
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  /** A Rich Message from standard Markdown (Bot API 10.1). */
  sendRichMessage(
    chatId: number,
    markdown: string,
  ): Promise<{ message_id: number }>;
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
}

/**
 * The real sender over grammY. grammY 1.46 doesn't type `sendRichMessage`
 * yet, so it goes through the raw API, which passes any method name on.
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
    sendChatAction: (chatId, action) => api.sendChatAction(chatId, action),
  };
}
