import type { DbOrTx } from "@winston/db/client";
import type { Logger } from "@winston/shared/logger";
import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import { healthRoutes } from "./routes/health.ts";
import { telegramWebhookRoutes } from "./routes/telegram-webhook.ts";
import type { TelegramSender } from "./telegram/handle-update.ts";

export interface ApiDeps {
  db: DbOrTx;
  logger: Logger;
  telegram: {
    sender: TelegramSender;
    botId: string;
    webhookSecret: string;
  };
}

export interface ApiEnv {
  Variables: RequestIdVariables & { logger: Logger };
}

/** The public API: webhooks and OAuth callbacks (docs/design.md §9). */
export function createApp(deps: ApiDeps) {
  const app = new Hono<ApiEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    const logger = deps.logger.child({ requestId: c.get("requestId") });
    c.set("logger", logger);
    const started = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  });

  app.onError((error, c) => {
    c.get("logger").error({ err: error }, "unhandled error");
    return c.json(
      { error: "internal_error", requestId: c.get("requestId") },
      500,
    );
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.route("/health", healthRoutes(deps));
  app.route("/webhooks/telegram", telegramWebhookRoutes(deps));
  return app;
}
