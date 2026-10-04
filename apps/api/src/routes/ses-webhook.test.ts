import { describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import type { DbOrTx } from "@winston/db/client";
import { jobs, mailSuppressions } from "@winston/db/schema";
import { inRollback, testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ApiEnv } from "../app.ts";
import { snsVerifier, stringToSign, type SnsMessage } from "../sns.ts";
import { sesWebhookRoutes } from "./ses-webhook.ts";

const db = await testDb();
const logger = createLogger("api-test", {
  pretty: false,
  destination: { write: () => undefined },
});

// Our own key stands in for AWS's certificate.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const certUrl =
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem";
const topic = "arn:aws:sns:us-east-1:766577085959:winston-mail-Inbound";
const eventsTopic =
  "arn:aws:sns:us-east-1:766577085959:winston-mail-SendingEvents";
const fetched: string[] = [];
const verify = snsVerifier((url) => {
  fetched.push(url);
  return Promise.resolve(publicKey.export({ type: "spki", format: "pem" }));
});

function signed(
  fields: Omit<
    SnsMessage,
    | "Signature"
    | "SignatureVersion"
    | "SigningCertURL"
    | "TopicArn"
    | "Timestamp"
    | "MessageId"
  > &
    Partial<SnsMessage>,
): SnsMessage {
  const message: SnsMessage = {
    MessageId: "sns-1",
    TopicArn: topic,
    Timestamp: "2026-10-04T12:00:00.000Z",
    SignatureVersion: "2",
    SigningCertURL: certUrl,
    Signature: "",
    ...fields,
  };
  return {
    ...message,
    Signature: createSign("RSA-SHA256")
      .update(stringToSign(message))
      .sign(privateKey, "base64"),
    ...(fields.Signature !== undefined ? { Signature: fields.Signature } : {}),
  };
}

/** SES's notification for a message written to the bucket (trimmed to what we read). */
const received = (verdicts: Record<string, string> = {}) =>
  JSON.stringify({
    notificationType: "Received",
    mail: { messageId: "ses-1", commonHeaders: { subject: "Hi" } },
    receipt: {
      recipients: ["ada@runwinston.email"],
      spfVerdict: { status: "PASS" },
      dkimVerdict: { status: "PASS" },
      dmarcVerdict: { status: "PASS" },
      spamVerdict: { status: "PASS" },
      virusVerdict: { status: verdicts.virus ?? "PASS" },
      action: {
        type: "S3",
        bucketName: "inbound",
        objectKey: "inbound/ses-1",
        topicArn: topic,
      },
    },
  });

function app(tx: DbOrTx, confirmed: string[], configured = true) {
  return new Hono<ApiEnv>()
    .use(async (c, next) => {
      c.set("logger", logger);
      await next();
    })
    .route(
      "/webhooks/ses",
      sesWebhookRoutes({
        db: tx,
        inboundTopicArn: configured ? topic : undefined,
        eventsTopicArn: eventsTopic,
        verify,
        confirm: (url) => {
          confirmed.push(url);
          return Promise.resolve();
        },
      }),
    );
}

const post = (
  tx: DbOrTx,
  body: unknown,
  confirmed: string[] = [],
  configured = true,
) =>
  app(tx, confirmed, configured).request("/webhooks/ses", {
    method: "POST",
    // SNS posts JSON as text/plain.
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const queued = (tx: DbOrTx) =>
  tx.select().from(jobs).where(eq(jobs.type, "receive_mail"));

describe("SES webhook", () => {
  test("a signed notification queues receive_mail once, with where the mail is and SES's verdicts", async () => {
    await inRollback(db, async (tx) => {
      const notification = signed({
        Type: "Notification",
        Message: received(),
        Subject: "Amazon SES Email Receipt Notification",
      });
      expect((await post(tx, notification)).status).toBe(204);
      expect((await post(tx, notification)).status).toBe(204);
      const jobsQueued = await queued(tx);
      expect(jobsQueued).toHaveLength(1);
      expect(jobsQueued[0]?.payload).toEqual({
        key: "inbound/ses-1",
        sesMessageId: "ses-1",
        recipients: ["ada@runwinston.email"],
        verdicts: {
          spf: "PASS",
          dkim: "PASS",
          dmarc: "PASS",
          spam: "PASS",
          virus: "PASS",
        },
      });
      // The certificate was fetched once, from AWS's host.
      expect(new Set(fetched)).toEqual(new Set([certUrl]));
    });
  });

  test("a forged, re-signed, SHA1, foreign-certificate or other-topic post is refused", async () => {
    await inRollback(db, async (tx) => {
      const good = signed({ Type: "Notification", Message: received() });
      const tampered = { ...good, Message: received({ virus: "FAIL" }) };
      const sha1 = signed({
        Type: "Notification",
        Message: received(),
        SignatureVersion: "1",
      });
      const foreignCert = signed({
        Type: "Notification",
        Message: received(),
        SigningCertURL:
          "https://sns.us-east-1.amazonaws.com.evil.example/cert.pem",
      });
      const otherTopic = signed({
        Type: "Notification",
        Message: received(),
        TopicArn: "arn:aws:sns:us-east-1:111111111111:someone-else",
      });
      for (const body of [tampered, sha1, foreignCert, otherTopic])
        expect((await post(tx, body)).status).toBe(401);
      expect(await queued(tx)).toHaveLength(0);
    });
  });

  test("a subscription confirmation is confirmed through its SNS URL", async () => {
    await inRollback(db, async (tx) => {
      const confirmed: string[] = [];
      const subscribe =
        "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=t";
      const response = await post(
        tx,
        signed({
          Type: "SubscriptionConfirmation",
          Message: "You have chosen to subscribe",
          SubscribeURL: subscribe,
          Token: "t",
        }),
        confirmed,
      );
      expect(response.status).toBe(204);
      expect(confirmed).toEqual([subscribe]);

      // A SubscribeURL anywhere else isn't visited.
      const elsewhere = await post(
        tx,
        signed({
          Type: "SubscriptionConfirmation",
          Message: "m",
          SubscribeURL: "https://evil.example/confirm",
          Token: "t",
        }),
        confirmed,
      );
      expect(elsewhere.status).toBe(401);
      expect(confirmed).toHaveLength(1);
    });
  });

  test("malformed posts and other notifications are acknowledged and ignored; unconfigured, it refuses", async () => {
    await inRollback(db, async (tx) => {
      expect((await post(tx, "not json")).status).toBe(204);
      expect(
        (
          await post(
            tx,
            signed({
              Type: "Notification",
              Message: JSON.stringify({ notificationType: "Bounce" }),
            }),
          )
        ).status,
      ).toBe(204);
      expect(await queued(tx)).toHaveLength(0);
      expect(
        (
          await post(
            tx,
            signed({ Type: "Notification", Message: received() }),
            [],
            false,
          )
        ).status,
      ).toBe(503);
    });
  });

  test("a permanent bounce or a complaint suppresses the address; a soft bounce or delivery doesn't", async () => {
    await inRollback(db, async (tx) => {
      const event = (body: unknown) =>
        signed({
          Type: "Notification",
          TopicArn: eventsTopic,
          Message: JSON.stringify(body),
        });
      const recipients = (...emails: string[]) =>
        emails.map((emailAddress) => ({ emailAddress }));
      for (const body of [
        {
          eventType: "Bounce",
          bounce: {
            bounceType: "Permanent",
            bouncedRecipients: recipients("Gone@Acme.example"),
          },
        },
        {
          eventType: "Complaint",
          complaint: { complainedRecipients: recipients("angry@example.com") },
        },
        {
          eventType: "Bounce",
          bounce: {
            bounceType: "Transient",
            bouncedRecipients: recipients("full@example.com"),
          },
        },
        {
          eventType: "Delivery",
          delivery: { recipients: ["fine@example.com"] },
        },
      ])
        expect((await post(tx, event(body))).status).toBe(204);
      const rows = await tx.select().from(mailSuppressions);
      expect(rows.map((r) => [r.address, r.reason]).toSorted()).toEqual([
        ["angry@example.com", "complaint"],
        ["gone@acme.example", "bounce"],
      ]);
      expect(await queued(tx)).toHaveLength(0);
    });
  });
});
