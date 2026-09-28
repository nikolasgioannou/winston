import type { DbOrTx } from "@winston/db/client";
import { outboundMessages } from "@winston/db/schema";
import type { ToolDefinition } from "@winston/prompts";
import { tool } from "ai";
import type { Logger } from "@winston/shared/logger";
import { z } from "zod";
import type { TelegramSender } from "../telegram/sender.ts";
import { keepLineBreaks } from "../telegram/line-breaks.ts";
import { sanitizeRichMarkdown } from "../telegram/sanitize.ts";
import { richMessageLimit, splitText } from "../telegram/split.ts";

export type { TelegramSender };

const description =
  "End your turn. Any text you write in the same step is sent first. Call it without writing anything when nothing needs saying.";
const inputSchema = z.object({});

/** How `end_turn` appears to the model, for the prompt version. */
export const endTurnDefinition: ToolDefinition = {
  name: "end_turn",
  description,
  inputSchema: z.toJSONSchema(inputSchema),
};

/**
 * Ends the turn (docs/design.md §4); called without text, it's deliberate
 * silence. It has an `execute` so the call and its result are both stored; a
 * call without a result would make the next request invalid.
 */
export const endTurnTool = tool({
  description,
  inputSchema,
  execute: () => Promise.resolve("Turn ended."),
});

/**
 * Sends one of the turn's messages as a Telegram Rich Message: the model's Markdown,
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
        .sendRichMessage(chatId, sanitizeRichMarkdown(keepLineBreaks(part)))
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
