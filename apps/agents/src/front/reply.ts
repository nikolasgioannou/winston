import type { DbOrTx } from "@winston/db/client";
import { outboundMessages } from "@winston/db/schema";
import type { ToolDefinition } from "@winston/prompts";
import { tool } from "ai";
import type { Logger } from "@winston/shared/logger";
import { z } from "zod";
import type { TelegramSender } from "../telegram/sender.ts";
import { sanitizeRichMarkdown } from "../telegram/sanitize.ts";
import { richMessageLimit, splitText } from "../telegram/split.ts";

export type { TelegramSender };

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
 * Sends the turn's reply as a Telegram Rich Message: the model's Markdown,
 * with images and HTML neutralized (docs/design.md §4, "Telegram
 * formatting"; `sanitizeRichMarkdown`), split only past Rich
 * Messages' 32,768-character limit. A part Telegram won't take as a Rich
 * Message is re-sent as plain text, so a reply is never lost. If a part fails
 * outright, what was already sent is still recorded.
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
    for (const part of splitText(context.text, richMessageLimit)) {
      const sent = await telegram
        .sendRichMessage(chatId, sanitizeRichMarkdown(part))
        .catch((error: unknown) => {
          context.logger.warn(
            { err: error },
            "Telegram rejected the rich message; sending as plain text",
          );
          return telegram.sendMessage(chatId, part);
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
