/**
 * Stored inbound items as envelope items (docs/design.md §4): one path for
 * the front of house's context window and for history search, so both read
 * the same.
 */
import type { DbOrTx } from "./client.ts";
import { inboundItems, outboundMessages } from "./schema/index.ts";
import type { EnvelopeItem, ReplyContext } from "@winston/domain/envelope";
import {
  taskNeedsUserPayloadSchema,
  taskResultPayloadSchema,
  taskResultTypes,
  userMessagePayloadSchema,
} from "@winston/domain/inbound";
import { and, arrayContains, eq, sql } from "drizzle-orm";

type InboundItem = typeof inboundItems.$inferSelect;

/** Turns stored inbound items into envelope items, resolving what each reply replies to. */
export async function toEnvelopeItems(
  db: DbOrTx,
  userId: string,
  items: readonly InboundItem[],
): Promise<EnvelopeItem[]> {
  return Promise.all(
    items.map(async (item): Promise<EnvelopeItem> => {
      if (item.type === "task.needs_user")
        return {
          kind: "task",
          type: "task.needs_user",
          occurredAt: item.occurredAt,
          payload: taskNeedsUserPayloadSchema.parse(item.payload),
        };
      const taskType = taskResultTypes.find((type) => type === item.type);
      if (taskType)
        return {
          kind: "task",
          type: taskType,
          occurredAt: item.occurredAt,
          payload: taskResultPayloadSchema.parse(item.payload),
        };
      if (item.type !== "user_message")
        return {
          kind: "event",
          type: item.type,
          occurredAt: item.occurredAt,
          data: item.payload,
        };
      const payload = userMessagePayloadSchema.parse(item.payload);
      const replyTo =
        payload.replyToTelegramMessageId === undefined
          ? undefined
          : await findReplyTarget(db, userId, payload.replyToTelegramMessageId);
      return {
        kind: "user_message",
        occurredAt: item.occurredAt,
        payload,
        ...(replyTo ? { replyTo } : {}),
      };
    }),
  );
}

/** The message with this Telegram id: one Winston sent, or one the user sent earlier. */
async function findReplyTarget(
  db: DbOrTx,
  userId: string,
  telegramMessageId: number,
): Promise<ReplyContext | undefined> {
  const [sent] = await db
    .select({ text: outboundMessages.text })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.userId, userId),
        arrayContains(outboundMessages.telegramMessageIds, [telegramMessageId]),
      ),
    );
  if (sent) return { from: "winston", text: sent.text };
  const [received] = await db
    .select({ payload: inboundItems.payload })
    .from(inboundItems)
    .where(
      and(
        eq(inboundItems.userId, userId),
        eq(inboundItems.type, "user_message"),
        sql`${inboundItems.payload}->>'telegramMessageId' = ${String(telegramMessageId)}`,
      ),
    );
  if (!received) return undefined;
  return {
    from: "user",
    text: userMessagePayloadSchema.parse(received.payload).text,
  };
}
