/**
 * Sending Winston's own mail (ead827, docs/runbooks/email.md): SES v2's
 * SendEmail with the raw MIME, through the Mail stack's configuration set so
 * bounces and complaints come back. Locally there's no SES: the message is
 * logged, not sent.
 */
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { MailSender } from "@winston/connectors/winston-mail";
import type { Logger } from "@winston/shared/logger";

export function sesSender(
  configurationSet: string,
  client = new SESv2Client(),
): MailSender {
  return {
    async send(raw, { from, to }) {
      const { MessageId } = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          // Every recipient, Bcc included, since Bcc isn't in the headers.
          Destination: { ToAddresses: to },
          Content: { Raw: { Data: raw } },
          ConfigurationSetName: configurationSet,
        }),
      );
      if (!MessageId) throw new Error("SES sent no message id");
      return { sesMessageId: MessageId };
    },
  };
}

/** Locally: says what would have been sent, and gives it a made-up id. */
export function loggingSender(logger: Logger): MailSender {
  return {
    send(raw, { from, to }) {
      logger.info({ from, to, bytes: raw.byteLength }, "would send mail");
      return Promise.resolve({ sesMessageId: `local-${crypto.randomUUID()}` });
    },
  };
}
