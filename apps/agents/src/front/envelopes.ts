import type { DbOrTx } from "@winston/db/client";
import { inboundItems, outboundMessages } from "@winston/db/schema";
import type { EnvelopeItem, ReplyContext } from "@winston/domain/envelope";
import { userMessagePayloadSchema } from "@winston/domain/inbound";
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
