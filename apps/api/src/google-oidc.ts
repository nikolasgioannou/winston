/**
 * Verifying the OIDC tokens Google signs for Pub/Sub push requests
 * (docs/design.md §3; Google's "Authenticate push subscriptions"): the token
 * is a JWT from Google with our audience, signed by a key in Google's JWKS,
 * naming the service account we configured, with a verified email.
 * Verification is offline against the cached keys.
 */
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

/** Google's signing keys for ID tokens. */
export const googleJwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const issuers = ["https://accounts.google.com", "accounts.google.com"];

export interface PushIdentity {
  /** The push subscription's audience (our endpoint). */
  audience: string;
  /** The service account the subscription signs as. */
  serviceAccount: string;
}

/**
 * Whether `authorization` (the request's header) carries a valid token for
 * this push identity. Returns the reason when it doesn't.
 */
export async function verifyPushToken(
  authorization: string | undefined,
  expected: PushIdentity,
  keys: JWTVerifyGetKey = googleJwks,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return { ok: false, reason: "no bearer token" };
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: issuers,
      audience: expected.audience,
    });
    if (payload.email !== expected.serviceAccount)
      return { ok: false, reason: "wrong service account" };
    if (payload.email_verified !== true)
      return { ok: false, reason: "unverified email" };
    return { ok: true };
  } catch (error) {
    if (error instanceof errors.JOSEError)
      return { ok: false, reason: error.code };
    throw error;
  }
}
