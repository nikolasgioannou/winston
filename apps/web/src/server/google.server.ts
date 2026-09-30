/**
 * Google OAuth 2.0 (docs/design.md §5, §9), Authorization Code with PKCE,
 * written by hand following the reference code arctic left when it was
 * deprecated (2026-07). Two separate grants on one client: signing in asks for
 * identity only (`openid email profile`), and connecting an account asks for
 * one domain's scopes, offline, so a refresh token comes back.
 */
import type { ConnectionDomain } from "@winston/domain/connections";
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

const connectScopePrefix = "https://www.googleapis.com/auth/";

/**
 * What connecting each domain asks Google for (docs/runbooks/google-cloud.md),
 * and the scope it can't work without. The user can untick scopes on Google's
 * screen, so the callback checks what was granted.
 */
export const connectGrants = {
  mail: {
    provider: "gmail",
    scopes: ["gmail.modify"],
    required: "gmail.modify",
  },
  calendar: {
    provider: "google_calendar",
    scopes: [
      "calendar.events",
      "calendar.calendarlist.readonly",
      "calendar.events.freebusy",
    ],
    required: "calendar.events",
  },
} as const satisfies Record<
  ConnectionDomain,
  { provider: string; scopes: readonly string[]; required: string }
>;

/** Every scope connecting asks for, in any domain. */
const connectScopes: ReadonlySet<string> = new Set(
  Object.values(connectGrants).flatMap((grant) => grant.scopes),
);

/** A scope's full URL, as Google names it. */
export const scopeUrl = (scope: string) => `${connectScopePrefix}${scope}`;

/**
 * Where to send the browser to connect an account for `domain`: offline
 * access and forced consent, so a refresh token is always issued, and the
 * account chooser (or `loginHint`, to reconnect a known account).
 */
export function googleConnectUrl(
  client: GoogleClient,
  {
    state,
    codeVerifier,
    domain,
    loginHint,
  }: {
    state: string;
    codeVerifier: string;
    domain: ConnectionDomain;
    loginHint?: string | undefined;
  },
) {
  const url = new URL(authorizeEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    // The ID token's email says which account was connected.
    scope: [
      "openid",
      "email",
      ...connectGrants[domain].scopes.map(scopeUrl),
    ].join(" "),
    state,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
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

/** A Google OAuth flow failed; `message` says why, for the logs. */
export class GoogleAuthError extends Error {
  override name = "GoogleAuthError";
}

const tokenResponseSchema = z.object({
  id_token: z.string(),
  refresh_token: z.string().optional(),
  /** The scopes granted, space-separated. */
  scope: z.string().optional(),
});

/** Trades the callback's code for tokens at Google's token endpoint. */
async function requestTokens(
  client: GoogleClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  send: typeof fetch,
) {
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
    throw new GoogleAuthError(
      `Google's token endpoint answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`,
    );
  const body = tokenResponseSchema.safeParse(await response.json());
  if (!body.success)
    throw new GoogleAuthError("No ID token in Google's response.");
  return body.data;
}

/**
 * Checks an ID token that came straight from Google's token endpoint over
 * TLS, authenticated with our client secret, so Google considers its
 * signature check optional; its issuer, audience, expiry and email
 * verification are still checked.
 */
function verifyIdToken(client: GoogleClient, idToken: string, now: number) {
  const claims = claimsSchema.safeParse(decodeJwtPayload(idToken));
  if (!claims.success)
    throw new GoogleAuthError(
      `The ID token didn't check out: ${z.prettifyError(claims.error)}`,
    );
  if (claims.data.aud !== client.clientId)
    throw new GoogleAuthError("The ID token is for a different client.");
  if (claims.data.exp * 1000 <= now)
    throw new GoogleAuthError("The ID token has expired.");
  return claims.data;
}

/** Exchanges a sign-in callback's code for the user's identity. */
export async function exchangeGoogleCode(
  client: GoogleClient,
  code: { code: string; codeVerifier: string },
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<GoogleClaims> {
  const tokens = await requestTokens(client, code, options.fetch ?? fetch);
  return verifyIdToken(client, tokens.id_token, options.now ?? Date.now());
}

/** What connecting an account got: whose it is, its refresh token and the scopes granted. */
export interface GoogleGrant {
  /** The connected account's address, lowercase. */
  email: string;
  refreshToken: string;
  /** Short names (`gmail.modify`), only the ones connecting asks for (not `openid` or `email`). */
  grantedScopes: string[];
}

/** Exchanges a connect callback's code for the grant. */
export async function exchangeGoogleConnectCode(
  client: GoogleClient,
  code: { code: string; codeVerifier: string },
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<GoogleGrant> {
  const tokens = await requestTokens(client, code, options.fetch ?? fetch);
  const claims = verifyIdToken(
    client,
    tokens.id_token,
    options.now ?? Date.now(),
  );
  if (!tokens.refresh_token)
    throw new GoogleAuthError("Google didn't issue a refresh token.");
  return {
    email: claims.email.toLowerCase(),
    refreshToken: tokens.refresh_token,
    grantedScopes: (tokens.scope ?? "")
      .split(" ")
      .filter((scope) => scope.startsWith(connectScopePrefix))
      .map((scope) => scope.slice(connectScopePrefix.length))
      .filter((scope) => connectScopes.has(scope)),
  };
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
