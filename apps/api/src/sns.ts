/**
 * Amazon SNS's HTTPS deliveries (docs/design.md §3, Winston's own mailbox):
 * every message is signed, so we check the signature against AWS's
 * certificate before believing it. Topics sign with SHA256 (signature
 * version 2, set in the Mail stack); version 1 (SHA1) is refused.
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */
import { createVerify } from "node:crypto";
import { z } from "zod";

export const snsMessage = z.object({
  Type: z.enum([
    "Notification",
    "SubscriptionConfirmation",
    "UnsubscribeConfirmation",
  ]),
  MessageId: z.string(),
  TopicArn: z.string(),
  Message: z.string(),
  Timestamp: z.string(),
  SignatureVersion: z.string(),
  Signature: z.string(),
  SigningCertURL: z.string(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
});
export type SnsMessage = z.infer<typeof snsMessage>;

/** An SNS endpoint in some region over HTTPS, and nothing posing as one. */
export function isSnsUrl(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** The text SNS signed: the message's fields, by name, in a fixed order. */
export function stringToSign(message: SnsMessage) {
  const fields =
    message.Type === "Notification"
      ? ([
          "Message",
          "MessageId",
          "Subject",
          "Timestamp",
          "TopicArn",
          "Type",
        ] as const)
      : ([
          "Message",
          "MessageId",
          "SubscribeURL",
          "Timestamp",
          "Token",
          "TopicArn",
          "Type",
        ] as const);
  return fields
    .flatMap((field) => {
      const value = message[field];
      // Subject is signed only when there is one.
      return value === undefined ? [] : [`${field}\n${value}\n`];
    })
    .join("");
}

/** Fetches a signing certificate (PEM); tests pass their own key instead. */
export type FetchSigningCert = (url: string) => Promise<string>;

const fetchCert: FetchSigningCert = async (url) => {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`SNS certificate ${url}: ${String(response.status)}`);
  return response.text();
};

/**
 * Checks SNS signatures, caching certificates by URL (AWS rotates them
 * rarely, and a new one has a new URL).
 */
export function snsVerifier(fetchSigningCert: FetchSigningCert = fetchCert) {
  const certs = new Map<string, Promise<string>>();
  return async (message: SnsMessage): Promise<boolean> => {
    if (message.SignatureVersion !== "2") return false;
    if (!isSnsUrl(message.SigningCertURL)) return false;
    let cert = certs.get(message.SigningCertURL);
    if (!cert) {
      cert = fetchSigningCert(message.SigningCertURL);
      certs.set(message.SigningCertURL, cert);
      // A failed fetch isn't remembered.
      cert.catch(() => certs.delete(message.SigningCertURL));
    }
    try {
      return createVerify("RSA-SHA256")
        .update(stringToSign(message), "utf8")
        .verify(await cert, message.Signature, "base64");
    } catch {
      return false;
    }
  };
}

export type SnsVerify = ReturnType<typeof snsVerifier>;
