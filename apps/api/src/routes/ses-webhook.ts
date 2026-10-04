/**
 * Winston's own mail (ead827, docs/design.md §3), from SES through SNS. On
 * the inbound topic: SES wrote a received message to the inbound bucket, so
 * a `receive_mail` job is queued (once per SES message). On the sending
 * events topic: a permanent bounce or a complaint suppresses the address, so
 * he never mails it again. Posts are checked (signature and topic) and
 * acknowledged at once; subscription confirmations are confirmed; anything
 * else is acknowledged and ignored, so SNS doesn't retry it.
 */
import { enqueue } from "@winston/db/queue";
import { mailSuppressions } from "@winston/db/schema";
import { receiveMailJob, type ReceiveMailPayload } from "@winston/domain/jobs";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiDeps, ApiEnv } from "../app.ts";
import { isSnsUrl, snsMessage, type SnsVerify } from "../sns.ts";

const verdict = z.object({ status: z.string() });

/** The parts of SES's "Received" notification (S3 action) we use. */
const received = z.object({
  notificationType: z.literal("Received"),
  mail: z.object({ messageId: z.string() }),
  receipt: z.object({
    recipients: z.array(z.string()),
    spfVerdict: verdict,
    dkimVerdict: verdict,
    dmarcVerdict: verdict,
    spamVerdict: verdict,
    virusVerdict: verdict,
    action: z.object({
      type: z.literal("S3"),
      objectKey: z.string(),
    }),
  }),
});

/** SES's sending events (configuration set) that stop mail to an address. */
const recipients = z.array(z.object({ emailAddress: z.string() }));
const sendingEvent = z.discriminatedUnion("eventType", [
  z.object({
    eventType: z.literal("Bounce"),
    bounce: z.object({
      bounceType: z.string(),
      bouncedRecipients: recipients,
    }),
  }),
  z.object({
    eventType: z.literal("Complaint"),
    complaint: z.object({ complainedRecipients: recipients }),
  }),
]);

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export interface SesWebhookDeps extends Pick<ApiDeps, "db"> {
  /** The inbound topic's ARN; unset where SES isn't set up, and the route refuses everything. */
  inboundTopicArn: string | undefined;
  /** The sending events topic's ARN (bounces and complaints). */
  eventsTopicArn?: string | undefined;
  verify: SnsVerify;
  /** Visits a SubscribeURL, confirming the subscription. */
  confirm?: (url: string) => Promise<void>;
}

const visit = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Confirming the subscription: ${String(response.status)}`);
};

export function sesWebhookRoutes(deps: SesWebhookDeps) {
  const confirm = deps.confirm ?? visit;
  return new Hono<ApiEnv>().post("/", async (c) => {
    const logger = c.get("logger");
    if (!deps.inboundTopicArn) return c.json({ error: "not_configured" }, 503);
    // SNS posts JSON as text/plain.
    const body = snsMessage.safeParse(
      await c.req
        .text()
        .then((text) => JSON.parse(text) as unknown)
        .catch(() => undefined),
    );
    if (!body.success) {
      logger.warn("ignoring a malformed SNS post");
      return c.body(null, 204);
    }
    const message = body.data;
    const topics = [deps.inboundTopicArn, deps.eventsTopicArn];
    if (!topics.includes(message.TopicArn) || !(await deps.verify(message))) {
      logger.warn(
        { topic: message.TopicArn, type: message.Type },
        "rejected an SNS post",
      );
      return c.json({ error: "unauthorized" }, 401);
    }

    if (message.Type === "SubscriptionConfirmation") {
      if (!message.SubscribeURL || !isSnsUrl(message.SubscribeURL))
        return c.json({ error: "unauthorized" }, 401);
      await confirm(message.SubscribeURL);
      logger.info(
        { topic: message.TopicArn },
        "confirmed the SNS subscription",
      );
      return c.body(null, 204);
    }
    if (message.Type !== "Notification") return c.body(null, 204);

    if (message.TopicArn === deps.eventsTopicArn) {
      const event = sendingEvent.safeParse(parseJson(message.Message));
      // Deliveries, and bounces that may pass, need nothing.
      if (!event.success) return c.body(null, 204);
      const suppressed =
        event.data.eventType === "Bounce"
          ? event.data.bounce.bounceType === "Permanent"
            ? event.data.bounce.bouncedRecipients
            : []
          : event.data.complaint.complainedRecipients;
      if (suppressed.length > 0) {
        await deps.db
          .insert(mailSuppressions)
          .values(
            suppressed.map((r) => ({
              address: r.emailAddress.trim().toLowerCase(),
              reason:
                event.data.eventType === "Bounce"
                  ? ("bounce" as const)
                  : ("complaint" as const),
            })),
          )
          .onConflictDoNothing();
        logger.info(
          { reason: event.data.eventType, addresses: suppressed.length },
          "suppressed addresses Winston's mail went wrong for",
        );
      }
      return c.body(null, 204);
    }

    const notification = received.safeParse(parseJson(message.Message));
    if (!notification.success) {
      logger.warn(
        { messageId: message.MessageId },
        "ignoring an SES notification",
      );
      return c.body(null, 204);
    }
    const { mail, receipt } = notification.data;
    const payload: ReceiveMailPayload = {
      key: receipt.action.objectKey,
      sesMessageId: mail.messageId,
      recipients: receipt.recipients,
      verdicts: {
        spf: receipt.spfVerdict.status,
        dkim: receipt.dkimVerdict.status,
        dmarc: receipt.dmarcVerdict.status,
        spam: receipt.spamVerdict.status,
        virus: receipt.virusVerdict.status,
      },
    };
    await enqueue(deps.db, receiveMailJob.type, {
      payload,
      dedupeKey: receiveMailJob.dedupeKey(mail.messageId),
    });
    logger.info({ sesMessageId: mail.messageId }, "queued received mail");
    return c.body(null, 204);
  });
}
