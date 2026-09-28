import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compact signed tokens: `<base64url JSON payload>.<base64url HMAC-SHA256>`.
 * The payload isn't secret, only tamper-proof, and carries its own expiry
 * (`exp`, in milliseconds since the epoch).
 */
export function signPayload(payload: { exp: number }, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

/** The payload, if the signature is valid and it hasn't expired; otherwise undefined. */
export function verifySignedPayload(
  token: string,
  secret: string,
  now = Date.now(),
) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && payload.exp > now
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
