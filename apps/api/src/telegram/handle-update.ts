import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { inboundItems, telegramLinks } from "@winston/db/schema";
import type {
  ForwardOrigin,
  UserMessagePayload,
} from "@winston/domain/inbound";
import type { Logger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import type { Message, MessageOrigin, Update } from "grammy/types";

/** Update types the webhook subscribes to (`setWebhook`'s `allowed_updates`). */
export const allowedUpdates = ["message"] as const;

/** How long a turn waits for more messages, so a burst becomes one turn. */
export const frontTurnDebounceMs = 1_500;

export const unlinkedChatReply =
  "Sorry, I only work with the people I've been set up for.";

/** The Telegram calls the webhook makes. grammY's `Api` satisfies it. */
export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface TelegramDeps {
  db: DbOrTx;
  logger: Logger;
  telegram: TelegramSender;
  /** Scopes update ids, which are only unique per bot. */
  botId: string;
}

export type UpdateOutcome =
  | "stored"
  | "duplicate"
  | "ignored_update"
  | "ignored_chat"
  | "unlinked_chat"
  | "unsupported_message";

/**
 * Turns one Telegram update into an inbound item plus a debounced
 * front-of-house turn, in one transaction. Must stay fast: Telegram waits on
 * it, and the real work happens in the queued job.
 */
export async function handleUpdate(
  { db, logger, telegram, botId }: TelegramDeps,
  update: Update,
): Promise<UpdateOutcome> {
  const message = update.message;
  if (!message) return "ignored_update";
  // Winston only talks in private chats; groups and channels are never processed.
  if (message.chat.type !== "private") return "ignored_chat";

  const chatId = message.chat.id;
  const [link] = await db
    .select({ userId: telegramLinks.userId })
    .from(telegramLinks)
    .where(eq(telegramLinks.chatId, chatId));
  if (!link) {
    logger.info({ chatId }, "message from an unlinked chat");
    // Best effort: failing here would make Telegram redeliver the update.
    await telegram
      .sendMessage(chatId, unlinkedChatReply)
      .catch((error: unknown) => {
        logger.warn(
          { err: error, chatId },
          "replying to an unlinked chat failed",
        );
      });
    return "unlinked_chat";
  }

  const text = message.text;
  if (text === undefined) {
    logger.info(
      { userId: link.userId, updateId: update.update_id },
      "ignoring a message that isn't text",
    );
    return "unsupported_message";
  }

  const { userId } = link;
  return db.transaction(async (tx) => {
    const [item] = await tx
      .insert(inboundItems)
      .values({
        userId,
        type: "user_message",
        payload: userMessagePayload(message, text),
        sourceRef: `telegram:${botId}:${String(update.update_id)}`,
        occurredAt: fromUnix(message.date),
      })
      .onConflictDoNothing({ target: inboundItems.sourceRef })
      .returning({ id: inboundItems.id });
    if (!item) return "duplicate";

    await enqueue(tx, "front_turn", {
      userId,
      dedupeKey: `front_turn:${userId}`,
      delayMs: frontTurnDebounceMs,
      onDuplicate: "reschedule",
    });
    return "stored";
  });
}

function userMessagePayload(message: Message, text: string) {
  const payload: UserMessagePayload = {
    text,
    telegramMessageId: message.message_id,
  };
  if (message.reply_to_message)
    payload.replyToTelegramMessageId = message.reply_to_message.message_id;
  if (message.forward_origin)
    payload.forwardedFrom = forwardOrigin(message.forward_origin);
  return payload;
}

function forwardOrigin(origin: MessageOrigin): ForwardOrigin {
  const sentAt = fromUnix(origin.date).toISOString();
  switch (origin.type) {
    case "user": {
      const { first_name, last_name, username } = origin.sender_user;
      return withUsername(
        {
          kind: "user",
          name: [first_name, last_name].filter(Boolean).join(" "),
          sentAt,
        },
        username,
      );
    }
    case "hidden_user":
      return { kind: "hidden_user", name: origin.sender_user_name, sentAt };
    case "chat":
      return withUsername(
        { kind: "chat", name: chatName(origin.sender_chat), sentAt },
        "username" in origin.sender_chat
          ? origin.sender_chat.username
          : undefined,
      );
    case "channel":
      return withUsername(
        { kind: "channel", name: origin.chat.title, sentAt },
        origin.chat.username,
      );
  }
}

function chatName(chat: {
  title?: string | undefined;
  first_name?: string | undefined;
}) {
  return chat.title ?? chat.first_name ?? "";
}

function withUsername(origin: ForwardOrigin, username: string | undefined) {
  return username === undefined ? origin : { ...origin, username };
}

function fromUnix(seconds: number) {
  return new Date(seconds * 1000);
}
