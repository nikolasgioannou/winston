import { createServerFn } from "@tanstack/react-start";
import { webConfig } from "./config.server";
import { database } from "./db.server";
import { requireUser } from "./session.server";
import { createDeepLink } from "./telegram.server";
import { unlinkTelegram } from "@winston/db/telegram-link-tokens";

/** A fresh Connect Telegram link for the signed-in user. */
export const createTelegramLink = createServerFn({ method: "POST" }).handler(
  async () =>
    createDeepLink(
      database(),
      (await requireUser()).id,
      webConfig().TELEGRAM_BOT_USERNAME,
    ),
);

/** Disconnects the signed-in user's Telegram chat. */
export const disconnectTelegram = createServerFn({ method: "POST" }).handler(
  async () => ({
    disconnected: await unlinkTelegram(database(), (await requireUser()).id),
  }),
);
