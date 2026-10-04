import type { DbOrTx } from "@winston/db/client";
import type { Logger } from "@winston/shared/logger";
import { Hono } from "hono";
import { requestId, type RequestIdVariables } from "hono/request-id";
import type { PushIdentity } from "./google-oidc.ts";
import { calendarWebhookRoutes } from "./routes/calendar-webhook.ts";
import { gmailWebhookRoutes } from "./routes/gmail-webhook.ts";
import { healthRoutes } from "./routes/health.ts";
import { sesWebhookRoutes } from "./routes/ses-webhook.ts";
import { telegramWebhookRoutes } from "./routes/telegram-webhook.ts";
import { snsVerifier, type SnsVerify } from "./sns.ts";
import type { TelegramSender } from "./telegram/handle-update.ts";

export interface ApiDeps {
  db: DbOrTx;
  logger: Logger;
  telegram: {
    sender: TelegramSender;
    botId: string;
    webhookSecret: string;
  };
  /** Gmail push's identity, when it's configured (docs/runbooks/gcp-terraform.md). */
  gmailPush?: PushIdentity | undefined;
  /** Where SES announces Winston's received mail, when it's set up (docs/runbooks/email.md). */
  sesInboundTopicArn?: string | undefined;
  /** Checks SNS signatures; tests pass one that trusts their own key. */
  verifySns?: SnsVerify;
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
  app.route("/webhooks/calendar", calendarWebhookRoutes(deps));
  app.route(
    "/webhooks/gmail",
    gmailWebhookRoutes({ db: deps.db, push: deps.gmailPush }),
  );
  app.route(
    "/webhooks/ses",
    sesWebhookRoutes({
      db: deps.db,
      inboundTopicArn: deps.sesInboundTopicArn,
      verify: deps.verifySns ?? snsVerifier(),
    }),
  );
  return app;
}
