/**
 * Sign in with Google, identity only (docs/design.md §5, §9): OAuth 2.0
 * Authorization Code with PKCE, written by hand following the reference code
 * arctic left when it was deprecated (2026-07). Only `openid email profile`
 * is requested, never Gmail or Calendar.
 */
import { z } from "zod";

const authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const issuers = ["https://accounts.google.com", "accounts.google.com"] as const;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** PKCE's S256 challenge: the verifier's SHA-256, base64url. */
export function codeChallenge(codeVerifier: string) {
  return new Bun.CryptoHasher("sha256")
    .update(codeVerifier)
    .digest()
    .toString("base64url");
}

/** Where to send the browser to sign in. */
export function googleAuthorizationUrl(
  client: GoogleClient,
  { state, codeVerifier }: { state: string; codeVerifier: string },
) {
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
    // Lets people with several Google accounts pick the right one.
    prompt: "select_account",
  }).toString();
  return url.toString();
}

/** What the ID token says about who signed in. */
const claimsSchema = z.object({
  iss: z.enum(issuers),
  aud: z.string(),
  exp: z.number(),
  sub: z.string().min(1),
  email: z.email(),
  // Only verified emails count, since the allowlist is by email.
  email_verified: z.literal(true),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  name: z.string().optional(),
});

export type GoogleClaims = z.infer<typeof claimsSchema>;

/** Signing in with Google failed; `message` says why, for the logs. */
export class GoogleSignInError extends Error {
  override name = "GoogleSignInError";
}

/**
 * Exchanges the callback's code for the user's identity. The ID token comes
 * straight from Google's token endpoint over TLS, authenticated with our
 * client secret, so Google considers its signature check optional; its
 * issuer, audience, expiry and email verification are still checked.
 */
export async function exchangeGoogleCode(
  client: GoogleClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<GoogleClaims> {
  const { fetch: send = fetch, now = Date.now() } = options;
  const response = await send(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    }),
  });
  if (!response.ok)
    throw new GoogleSignInError(
      `Google's token endpoint answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`,
    );
  const body = z
    .object({ id_token: z.string() })
    .safeParse(await response.json());
  if (!body.success)
    throw new GoogleSignInError("No ID token in Google's response.");

  const claims = claimsSchema.safeParse(decodeJwtPayload(body.data.id_token));
  if (!claims.success)
    throw new GoogleSignInError(
      `The ID token didn't check out: ${z.prettifyError(claims.error)}`,
    );
  if (claims.data.aud !== client.clientId)
    throw new GoogleSignInError("The ID token is for a different client.");
  if (claims.data.exp * 1000 <= now)
    throw new GoogleSignInError("The ID token has expired.");
  return claims.data;
}

function decodeJwtPayload(jwt: string): unknown {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
