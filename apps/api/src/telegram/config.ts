import { z } from "zod";

export const telegramConfigSchema = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string()
    .regex(/^\d+:[\w-]+$/, "expected a bot token from @BotFather"),
  /** Telegram sends it with every webhook request (`secret_token`); 1–256 of `A-Za-z0-9_-`. */
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .regex(/^[\w-]{32,256}$/, "expected 32–256 letters, digits, _ or -"),
});

/** The bot's numeric id, the part of the token before the colon. */
export function botIdFromToken(token: string) {
  return token.slice(0, token.indexOf(":"));
}
