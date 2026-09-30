import type { DbOrTx } from "@winston/db/client";
import { enqueue } from "@winston/db/queue";
import { consumeLinkToken } from "@winston/db/telegram-link-tokens";
import {
  inboundItems,
  outboundMessages,
  telegramLinks,
} from "@winston/db/schema";
import {
  onboardingCompletedType,
  type Attachment,
  type ForwardOrigin,
  type ReactionPayload,
  type UserMessagePayload,
} from "@winston/domain/inbound";
import { frontTurnJob, saveAttachmentJob } from "@winston/domain/jobs";
import type { Logger } from "@winston/shared/logger";
import { and, arrayContains, eq, ne, sql } from "drizzle-orm";
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

export const badLinkReply =
  "That link has expired or was already used. Go back to Winston's website and tap Connect Telegram for a new one.";

export const alreadyLinkedReply = "You're already connected. Just message me.";

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
  | "linked"
  | "bad_link_token"
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

  const token = startToken(message);
  if (token !== undefined)
    return linkChat({ db, logger, telegram, botId }, update, message, token);

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

  // Text, or a file (voice notes included) with an optional caption.
  // Stickers, locations and the like aren't handled.
  const attachment =
    message.text === undefined ? attachmentOf(message) : undefined;
  const text =
    message.text ?? (attachment ? (message.caption ?? "") : undefined);
  if (text === undefined) {
    logger.info(
      { userId, updateId: update.update_id },
      "ignoring a message that isn't text or a file",
    );
    return "unsupported_message";
  }

  const payload = userMessagePayload(message, text);
  if (attachment) payload.attachment = attachment;
  return storeAndQueueTurn(db, userId, [
    {
      type: "user_message",
      payload,
      sourceRef: `telegram:${botId}:${String(update.update_id)}`,
      occurredAt: fromUnix(message.date),
      pending: attachment !== undefined,
    },
  ]);
}

/** The payload of `/start <payload>`, which the site's deep link sends. */
function startToken(message: Message) {
  return /^\/start(?:@\w+)?\s+(\S+)$/.exec(message.text ?? "")?.[1];
}

/**
 * Links this chat to the user whose token came in `/start <token>`
 * (docs/design.md §9): the token must be unused and unexpired. The chat moves
 * to them if another user had it, and replaces any chat they had before. A
 * newly linked chat gets the onboarding event, so Winston says hello in a
 * normal turn; relinking the same chat just says so.
 */
async function linkChat(
  { db, logger, telegram, botId }: TelegramDeps,
  update: Update,
  message: Message,
  token: string,
): Promise<UpdateOutcome> {
  const chatId = message.chat.id;
  const result = await db.transaction(async (tx) => {
    const userId = await consumeLinkToken(tx, token);
    if (!userId) return "bad_link_token" as const;

    const [previous] = await tx
      .select({ chatId: telegramLinks.chatId })
      .from(telegramLinks)
      .where(eq(telegramLinks.userId, userId));
    // A chat belongs to one user: take it from whoever had it.
    const moved = await tx
      .delete(telegramLinks)
      .where(
        and(eq(telegramLinks.chatId, chatId), ne(telegramLinks.userId, userId)),
      )
      .returning({ userId: telegramLinks.userId });
    for (const from of moved)
      logger.warn(
        { chatId, fromUserId: from.userId, toUserId: userId },
        "moved a Telegram chat to another user",
      );
    const link = {
      chatId,
      telegramUserId: message.from?.id ?? chatId,
      username: message.from?.username ?? null,
      linkedAt: sql`now()`,
    };
    await tx
      .insert(telegramLinks)
      .values({ userId, ...link })
      .onConflictDoUpdate({ target: telegramLinks.userId, set: link });
    logger.info({ userId, chatId }, "linked a Telegram chat");

    if (previous?.chatId === chatId) return "relinked" as const;
    await storeAndQueueTurn(tx, userId, [
      {
        type: onboardingCompletedType,
        payload: {},
        sourceRef: `telegram:${botId}:${String(update.update_id)}`,
        occurredAt: fromUnix(message.date),
      },
    ]);
    return "linked" as const;
  });

  if (result === "linked") return "linked";
  // Best effort, as for unlinked chats.
  await telegram
    .sendMessage(
      chatId,
      result === "relinked" ? alreadyLinkedReply : badLinkReply,
    )
    .catch((error: unknown) => {
      logger.warn({ err: error, chatId }, "replying to /start failed");
    });
  return result === "relinked" ? "linked" : "bad_link_token";
}

/**
 * The file a message carries, as Telegram describes it. A photo comes in
 * several sizes; the largest is kept. An animation also fills `document`
 * for older clients, so it's checked first.
 */
export function attachmentOf(message: Message): Attachment | undefined {
  const pending = { status: "pending" as const };
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo.reduce((best, size) =>
      size.width * size.height > best.width * best.height ? size : best,
    );
    return withOptional(
      {
        kind: "photo",
        telegramFileId: largest.file_id,
        mimeType: "image/jpeg",
        ...pending,
      },
      { size: largest.file_size },
    );
  }
  const file =
    (message.animation && {
      kind: "animation" as const,
      ...message.animation,
    }) ??
    (message.document && { kind: "document" as const, ...message.document }) ??
    (message.video && { kind: "video" as const, ...message.video }) ??
    (message.audio && { kind: "audio" as const, ...message.audio }) ??
    (message.voice && { kind: "voice" as const, ...message.voice });
  if (message.video_note)
    return withOptional(
      {
        kind: "video_note",
        telegramFileId: message.video_note.file_id,
        mimeType: "video/mp4",
        ...pending,
      },
      { size: message.video_note.file_size },
    );
  if (!file) return undefined;
  return withOptional(
    { kind: file.kind, telegramFileId: file.file_id, ...pending },
    {
      fileName: "file_name" in file ? file.file_name : undefined,
      mimeType: file.mime_type,
      size: file.file_size,
    },
  );
}

/** Adds only the fields that are set, since the payload schema has no undefined values. */
function withOptional<T extends object>(
  base: T,
  optional: Record<string, string | number | undefined>,
) {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(optional).filter((entry) => entry[1] !== undefined),
    ),
  } as T & Partial<Attachment>;
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
    /** Waits for its file to be saved before a turn can take it. */
    pending?: boolean;
  }[],
): Promise<UpdateOutcome> {
  return db.transaction(async (tx) => {
    const stored = await tx
      .insert(inboundItems)
      .values(items.map((item) => ({ ...item, userId })))
      .onConflictDoNothing({ target: inboundItems.sourceRef })
      .returning({ id: inboundItems.id, pending: inboundItems.pending });
    if (stored.length === 0) return "duplicate";

    // A held item's turn is queued once its file is saved.
    for (const item of stored.filter((row) => row.pending))
      await enqueue(tx, saveAttachmentJob.type, {
        userId,
        payload: { inboundItemId: item.id },
        dedupeKey: saveAttachmentJob.dedupeKey(item.id),
      });
    if (stored.every((row) => row.pending)) return "stored";

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
