import type { DbOrTx } from "@winston/db/client";
import { createLogger } from "@winston/shared/logger";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ApiDeps } from "./app.ts";

export const testWebhookSecret = "test-secret-0123456789abcdefghijklmnop";

/** Deps for driving the app in tests: captured log lines and a recording Telegram sender. */
export function testDeps(db: DbOrTx) {
  const logs: Record<string, unknown>[] = [];
  const sent: { chatId: number; text: string }[] = [];
  const logger = createLogger("api-test", {
    pretty: false,
    destination: {
      write: (line: string) =>
        logs.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const deps: ApiDeps = {
    db,
    logger,
    telegram: {
      sender: {
        sendMessage: (chatId, text) => {
          sent.push({ chatId, text });
          return Promise.resolve();
        },
      },
      botId: "123456",
      webhookSecret: testWebhookSecret,
    },
  };
  return { deps, logs, sent };
}

// Pub/Sub push tokens signed by a local key, standing in for Google's.
const { publicKey, privateKey } = await generateKeyPair("RS256");
export const testJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }],
});
export const testPush = {
  audience: "https://api.runwinston.com/webhooks/gmail",
  serviceAccount: "gmail-push@winston-510100.iam.gserviceaccount.com",
};

/** A token as Google would sign one, with any claims overridden. */
export async function pushToken(
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
) {
  return new SignJWT({
    email: testPush.serviceAccount,
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? "https://accounts.google.com")
    .setAudience(options.audience ?? testPush.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(privateKey);
}
