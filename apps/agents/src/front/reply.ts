import type { DbOrTx } from "@winston/db/client";
import { outboundMessages } from "@winston/db/schema";
import type { ToolDefinition } from "@winston/prompts";
import { tool } from "ai";
import { z } from "zod";

/** The Telegram calls the agents make. grammY's `Api` satisfies it. */
export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
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

/** Sends the turn's reply through Telegram and records it. */
export async function deliverReply(context: {
  db: DbOrTx;
  telegram: TelegramSender;
  userId: string;
  runId: string;
  chatId: number;
  text: string;
}) {
  const sent = await context.telegram.sendMessage(context.chatId, context.text);
  await context.db.insert(outboundMessages).values({
    userId: context.userId,
    runId: context.runId,
    text: context.text,
    telegramMessageIds: [sent.message_id],
  });
}
