/**
 * Where received mail waits and how it's bounced: SES's inbound bucket and
 * SendBounce in production, a directory and a log line locally (local
 * stacks don't receive real mail; docs/runbooks/email.md).
 */
import { SESClient, SendBounceCommand } from "@aws-sdk/client-ses";
import { mailboxDomain } from "@winston/domain/mailbox";
import type { Logger } from "@winston/shared/logger";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { awsS3Objects } from "@winston/blobs";
import type { InboundMailStore, MailBouncer } from "./receive.ts";

/** Keys SES writes (`inbound/<SES message id>`), and nothing that could leave the directory. */
export function checkedInboundKey(key: string) {
  if (!/^inbound\/[A-Za-z0-9._-]+$/.test(key) || key.includes(".."))
    throw new Error(`Not an inbound mail key: ${key}`);
  return key;
}

/** The inbound bucket when `INBOUND_MAIL_BUCKET` is set (production), else the directory. */
export function createInboundMailStore(config: {
  INBOUND_MAIL_BUCKET?: string | undefined;
  INBOUND_MAIL_DIR: string;
}): InboundMailStore {
  if (config.INBOUND_MAIL_BUCKET) {
    const objects = awsS3Objects(config.INBOUND_MAIL_BUCKET);
    return {
      get: (key) => objects.get(checkedInboundKey(key)),
      delete: (key) => objects.delete(checkedInboundKey(key)),
    };
  }
  return localInboundMailStore(config.INBOUND_MAIL_DIR);
}

export function localInboundMailStore(dir: string): InboundMailStore & {
  put(key: string, raw: Uint8Array): Promise<void>;
} {
  const path = (key: string) => join(dir, checkedInboundKey(key));
  return {
    async put(key, raw) {
      await mkdir(dirname(path(key)), { recursive: true });
      await Bun.write(path(key), raw);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(path(key)));
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
  };
}

/**
 * SES's SendBounce, which answers a received message with a standard bounce
 * (within a day of receiving it) from `mailer-daemon@` the domain.
 */
export function sesBouncer(client = new SESClient()): MailBouncer {
  return {
    async bounce({ sesMessageId, recipients }) {
      await client.send(
        new SendBounceCommand({
          OriginalMessageId: sesMessageId,
          BounceSender: `mailer-daemon@${mailboxDomain}`,
          BouncedRecipientInfoList: recipients.map((recipient) => ({
            Recipient: recipient,
            BounceType: "DoesNotExist",
          })),
        }),
      );
    },
  };
}

/** Locally there's no SES to bounce through: the bounce is logged. */
export function loggingBouncer(logger: Logger): MailBouncer {
  return {
    bounce({ sesMessageId, recipients }) {
      logger.info({ sesMessageId, recipients }, "would bounce mail");
      return Promise.resolve();
    },
  };
}
