import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A new secret token: 32 random bytes, base64url. */
export function generateToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * What gets stored instead of a token: its SHA-256, hex. Tokens are random
 * and high-entropy, so a fast hash is enough (no salt or slow KDF needed).
 */
export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` matches a stored hash, compared in constant time. */
export function tokenMatches(token: string, storedHash: string) {
  const given = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}
