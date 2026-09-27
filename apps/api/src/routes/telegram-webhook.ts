import { timingSafeEqual } from "node:crypto";
import type { Update } from "grammy/types";
import { Hono } from "hono";
import type { ApiDeps, ApiEnv } from "../app.ts";
import { handleUpdate } from "../telegram/handle-update.ts";

const secretHeader = "X-Telegram-Bot-Api-Secret-Token";

/** Telegram's webhook (registered by `bun run telegram:webhook`). */
export function telegramWebhookRoutes({ db, telegram }: ApiDeps) {
  const expected = Buffer.from(telegram.webhookSecret);
  const isAuthentic = (header: string | undefined) => {
    const given = Buffer.from(header ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  return new Hono<ApiEnv>().post("/", async (c) => {
    if (!isAuthentic(c.req.header(secretHeader))) return c.body(null, 401);
    const update = await c.req.json<Update>();
    const outcome = await handleUpdate(
      {
        db,
        logger: c.get("logger"),
        telegram: telegram.sender,
        botId: telegram.botId,
      },
      update,
    );
    c.get("logger").debug(
      { updateId: update.update_id, outcome },
      "telegram update",
    );
    return c.body(null, 200);
  });
}
