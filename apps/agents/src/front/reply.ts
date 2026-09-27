import type { DbOrTx } from "@winston/db/client";
import { outboundMessages } from "@winston/db/schema";
import type { ToolDefinition } from "@winston/prompts";
import { tool } from "ai";
import type { Logger } from "@winston/shared/logger";
import { z } from "zod";
import { formatForTelegram, visibleText } from "../telegram/format.ts";

/** The Telegram calls the agents make. grammY's `Api` satisfies it. */
export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    options?: { parse_mode?: "HTML" },
  ): Promise<{ message_id: number }>;
}

const description =
  "End your turn without messaging the user. Use it when nothing needs saying; any text you wrote is discarded.";
const inputSchema = z.object({});

/** How `no_reply` appears to the model, for the prompt version. */
export const noReplyDefinition: ToolDefinition = {
  name: "no_reply",
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

/**
 * Deliberate silence (docs/design.md §4). It has an `execute` so the call and
 * its result are both stored; a call without a result would make the next
 * request invalid. The turn's `stopWhen` ends the loop right after it.
 */
export const noReplyTool = tool({
  description,
  inputSchema,
  execute: () => Promise.resolve("Not sent."),
});

/**
 * Sends the turn's reply through Telegram as HTML converted from the agent's
 * Markdown (docs/design.md §4, "Telegram formatting"), as many messages as
 * its length needs, and records it. A part Telegram rejects as bad markup is
 * re-sent as plain text. If a part fails outright, what was already sent is
 * still recorded.
 */
export async function deliverReply(context: {
  db: DbOrTx;
  logger: Logger;
  telegram: TelegramSender;
  userId: string;
  runId: string;
  chatId: number;
  text: string;
}) {
  const { telegram, chatId } = context;
  const sentIds: number[] = [];
  try {
    for (const html of formatForTelegram(context.text)) {
      const sent = await telegram
        .sendMessage(chatId, html, { parse_mode: "HTML" })
        .catch((error: unknown) => {
          if (!isBadMarkup(error)) throw error;
          context.logger.warn(
            { err: error, html },
            "Telegram rejected the markup; sending as plain text",
          );
          return telegram.sendMessage(chatId, visibleText(html));
        });
      sentIds.push(sent.message_id);
    }
  } finally {
    if (sentIds.length > 0)
      await context.db.insert(outboundMessages).values({
        userId: context.userId,
        runId: context.runId,
        text: context.text,
        telegramMessageIds: sentIds,
      });
  }
}

/** Telegram's 400 for markup it can't parse ("Bad Request: can't parse entities: …"). */
function isBadMarkup(error: unknown) {
  const description =
    typeof error === "object" && error !== null && "description" in error
      ? String(error.description)
      : "";
  return /can't parse entities/i.test(description);
}
