import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import {
  inboundItems,
  outboundMessages,
  telegramLinks,
} from "@winston/db/schema";
import type {
  ForwardOrigin,
  ReactionPayload,
  UserMessagePayload,
} from "@winston/domain/inbound";
import { frontTurnJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, arrayContains, eq } from "drizzle-orm";
import type {
  Message,
  MessageOrigin,
  MessageReactionUpdated,
  Update,
} from "grammy/types";

/**
 * Update types the webhook subscribes to (`setWebhook`'s `allowed_updates`).
 * Telegram never sends `message_reaction` unless it's listed.
 */
export const allowedUpdates = ["message", "message_reaction"] as const;

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
  | "unsupported_message"
  | "ignored_reaction";

/** How much of a reacted-to message is kept for context. */
export const reactionTargetMaxChars = 200;

/**
 * Turns one Telegram update into inbound items plus a debounced
 * front-of-house turn, in one transaction. Must stay fast: Telegram waits on
 * it, and the real work happens in the queued job.
 */
export async function handleUpdate(
  deps: TelegramDeps,
  update: Update,
): Promise<UpdateOutcome> {
  if (update.message) return handleMessage(deps, update, update.message);
  if (update.message_reaction)
    return handleReaction(deps, update, update.message_reaction);
  return "ignored_update";
}

async function handleMessage(
  { db, logger, telegram, botId }: TelegramDeps,
  update: Update,
  message: Message,
): Promise<UpdateOutcome> {
  // Winston only talks in private chats; groups and channels are never processed.
  if (message.chat.type !== "private") return "ignored_chat";

  const chatId = message.chat.id;
  const userId = await linkedUser(db, chatId);
  if (!userId) {
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
      { userId, updateId: update.update_id },
      "ignoring a message that isn't text",
    );
    return "unsupported_message";
  }

  return storeAndQueueTurn(db, userId, [
    {
      type: "user_message",
      payload: userMessagePayload(message, text),
      sourceRef: `telegram:${botId}:${String(update.update_id)}`,
      occurredAt: fromUnix(message.date),
    },
  ]);
}

/**
 * A reaction becomes one `telegram.reaction.added` item per emoji the user
 * added. Removed reactions are ignored, and a changed one counts as the new
 * emoji. Only reactions to Winston's own messages count: without the target
 * there's nothing to go on.
 */
async function handleReaction(
  { db, logger, botId }: TelegramDeps,
  update: Update,
  reaction: MessageReactionUpdated,
): Promise<UpdateOutcome> {
  if (reaction.chat.type !== "private") return "ignored_chat";
  const userId = await linkedUser(db, reaction.chat.id);
  if (!userId) return "unlinked_chat";

  const emojis = (reactions: typeof reaction.new_reaction) =>
    reactions.flatMap((r) => (r.type === "emoji" ? [r.emoji] : []));
  const before = new Set(emojis(reaction.old_reaction));
  const added = emojis(reaction.new_reaction).filter(
    (emoji) => !before.has(emoji),
  );
  if (added.length === 0) return "ignored_reaction";

  const [target] = await db
    .select({ text: outboundMessages.text })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.userId, userId),
        arrayContains(outboundMessages.telegramMessageIds, [
          reaction.message_id,
        ]),
      ),
    );
  if (!target) {
    logger.info(
      { userId, telegramMessageId: reaction.message_id },
      "ignoring a reaction to a message Winston didn't send",
    );
    return "ignored_reaction";
  }

  const updateRef = `telegram:${botId}:${String(update.update_id)}`;
  return storeAndQueueTurn(
    db,
    userId,
    added.map((emoji, index) => {
      const payload: ReactionPayload = {
        emoji,
        target: {
          telegramMessageId: reaction.message_id,
          text: Array.from(target.text)
            .slice(0, reactionTargetMaxChars)
            .join(""),
        },
      };
      return {
        type: "telegram.reaction.added",
        payload,
        sourceRef:
          added.length === 1 ? updateRef : `${updateRef}:${String(index)}`,
        occurredAt: fromUnix(reaction.date),
      };
    }),
  );
}

async function linkedUser(db: DbOrTx, chatId: number) {
  const [link] = await db
    .select({ userId: telegramLinks.userId })
    .from(telegramLinks)
    .where(eq(telegramLinks.chatId, chatId));
  return link?.userId;
}

/** Stores the items and queues the user's debounced turn, unless they're redeliveries. */
async function storeAndQueueTurn(
  db: DbOrTx,
  userId: string,
  items: {
    type: string;
    payload: unknown;
    sourceRef: string;
    occurredAt: Date;
  }[],
): Promise<UpdateOutcome> {
  return db.transaction(async (tx) => {
    const stored = await tx
      .insert(inboundItems)
      .values(items.map((item) => ({ ...item, userId })))
      .onConflictDoNothing({ target: inboundItems.sourceRef })
      .returning({ id: inboundItems.id });
    if (stored.length === 0) return "duplicate";

    await enqueue(tx, frontTurnJob.type, {
      userId,
      dedupeKey: frontTurnJob.dedupeKey(userId),
      delayMs: frontTurnJob.debounceMs,
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
