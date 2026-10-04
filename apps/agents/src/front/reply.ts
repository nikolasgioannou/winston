import type { DbOrTx } from "@winston/db/client";
import { telegramLoginUrl } from "@winston/db/handoffs";
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
/**
 * A sign-in button for the first link to the site's browser page in a
 * message: tapping it signs the person in through Telegram on the way, so
 * the page opens ready even in Telegram's own browser (docs/design.md §5).
 */
export function loginButton(text: string, webPublicUrl: string) {
  const site = new URL(webPublicUrl).origin;
  const link = text.match(/https?:\/\/[^\s<>()"']+/g)?.find((url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === site && parsed.pathname === "/browser";
    } catch {
      return false;
    }
  });
  return link
    ? { text: "Open the browser", url: telegramLoginUrl(webPublicUrl, link) }
    : undefined;
}

export async function deliverReply(context: {
  db: DbOrTx;
  logger: Logger;
  telegram: TelegramSender;
  userId: string;
  runId: string;
  chatId: number;
  text: string;
  /** The site: a link to its browser page gets a Telegram sign-in button. */
  webPublicUrl?: string;
}) {
  const { telegram, chatId } = context;
  const sentIds: number[] = [];
  const parts = splitText(context.text, richMessageLimit);
  const login = context.webPublicUrl
    ? loginButton(context.text, context.webPublicUrl)
    : undefined;
  try {
    for (const [index, part] of parts.entries()) {
      const markdown = sanitizeRichMarkdown(keepLineBreaks(part));
      // The button rides on the last part; without the bot's domain linked
      // (BotFather's /setdomain) Telegram refuses it, so it's dropped.
      const withButton = login && index === parts.length - 1;
      const sent = await (
        withButton
          ? telegram
              .sendRichMessage(chatId, markdown, { login })
              .catch((error: unknown) => {
                context.logger.warn(
                  { err: error },
                  "Telegram refused the sign-in button; sending without it",
                );
                return telegram.sendRichMessage(chatId, markdown);
              })
          : telegram.sendRichMessage(chatId, markdown)
      ).catch((error: unknown) => {
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
