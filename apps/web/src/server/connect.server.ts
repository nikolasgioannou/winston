/**
 * Connecting an account (docs/design.md §12a): the site starts the flow for
 * the signed-in user and finishes it in the same session, so a forwarded link
 * can't attach someone else's account (the founder's call, 2026-09-29: the
 * callback lives in `web`, not `api`). Google accounts for mail and calendar;
 * Ramp (8f6c44).
 */
import {
  exchangeRampCode,
  RampAuthError,
  rampUserEmail,
  type RampClient,
} from "@winston/connectors/ramp-auth";
import type { DbOrTx } from "@winston/db/client";
import { saveConnection } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import { capabilityScopes } from "@winston/domain/connections";
import type { TokenVault } from "@winston/shared/token-vault";
import { hashToken, tokenMatches } from "@winston/shared/tokens";
import { and, eq } from "drizzle-orm";
import {
  connectGrants,
  exchangeGoogleConnectCode,
  GoogleAuthError,
  isGoogleDomain,
  type GoogleClient,
} from "./google.server";

/** Where Google sends the browser back (registered on the OAuth client). */
export const connectCallbackPath = "/auth/google/connect/callback";

/** Where Ramp sends the browser back (registered with Ramp, docs/runbooks/ramp.md). */
export const rampConnectCallbackPath = "/auth/ramp/connect/callback";

/** Why connecting didn't work, as `/accounts` shows it. */
export type ConnectProblem = "oauth" | "missing_scopes" | "unavailable";

export type ConnectResult =
  | { redirectTo: `/accounts?connected=${string}` }
  | { redirectTo: `/accounts?error=${ConnectProblem}` };

/** The flow's values, kept in cookies between the two redirects. */
export interface ConnectCookies {
  state: string | undefined;
  codeVerifier: string | undefined;
  domain: string | undefined;
}

const problem = (p: ConnectProblem) =>
  ({ redirectTo: `/accounts?error=${p}` }) as const;

/**
 * The code and verifier, if the provider's redirect is the one this browser
 * started: the state matches the cookie, and nothing was refused.
 */
function checkedRedirect(query: URLSearchParams, cookies: ConnectCookies) {
  const code = query.get("code");
  const state = query.get("state");
  // A cancelled consent comes back as ?error=access_denied.
  if (query.get("error") || !code || !state) return undefined;
  if (
    !cookies.state ||
    !cookies.codeVerifier ||
    !tokenMatches(state, hashToken(cookies.state))
  )
    return undefined;
  return { code, codeVerifier: cookies.codeVerifier };
}

/**
 * Handles Google's redirect back: checks the state, exchanges the code,
 * checks the domain's essential scope was granted, and saves the connection
 * with whatever was granted.
 */
export async function completeGoogleConnect(
  deps: {
    db: DbOrTx;
    google: GoogleClient;
    vault: TokenVault;
    fetch?: typeof fetch;
  },
  userId: string,
  query: URLSearchParams,
  cookies: ConnectCookies,
): Promise<ConnectResult> {
  const redirect = checkedRedirect(query, cookies);
  const domain = cookies.domain;
  if (!redirect || !isGoogleDomain(domain)) return problem("oauth");

  let grant;
  try {
    grant = await exchangeGoogleConnectCode(
      deps.google,
      redirect,
      deps.fetch ? { fetch: deps.fetch } : {},
    );
  } catch (error) {
    if (error instanceof GoogleAuthError) return problem("oauth");
    throw error;
  }
  const wanted = connectGrants[domain];
  if (!grant.grantedScopes.includes(wanted.required))
    return problem("missing_scopes");

  const { connectionId } = await saveConnection(deps.db, deps.vault, {
    userId,
    domain,
    provider: wanted.provider,
    externalEmail: grant.email,
    scopes: grant.grantedScopes,
    refreshToken: grant.refreshToken,
  });
  return { redirectTo: `/accounts?connected=${connectionId}` };
}

/**
 * Handles Ramp's redirect back: checks the state, exchanges the code, checks
 * reading was granted, asks Ramp who signed in, and saves the connection.
 */
export async function completeRampConnect(
  deps: {
    db: DbOrTx;
    ramp: RampClient | undefined;
    vault: TokenVault;
    fetch?: typeof fetch;
  },
  userId: string,
  query: URLSearchParams,
  cookies: ConnectCookies,
): Promise<ConnectResult> {
  if (!deps.ramp) return problem("unavailable");
  const redirect = checkedRedirect(query, cookies);
  if (!redirect || cookies.domain !== "ramp") return problem("oauth");

  let account: { email: string; scopes: string[]; refreshToken: string };
  try {
    const grant = await exchangeRampCode(deps.ramp, redirect, deps.fetch);
    if (!capabilityScopes.ramp.read.every((s) => grant.scopes.includes(s)))
      return problem("missing_scopes");
    account = {
      ...grant,
      email: await rampUserEmail(grant.accessToken, deps.fetch),
    };
  } catch (error) {
    if (error instanceof RampAuthError) return problem("oauth");
    throw error;
  }

  const { connectionId } = await saveConnection(deps.db, deps.vault, {
    userId,
    domain: "ramp",
    provider: "ramp",
    externalEmail: account.email,
    scopes: account.scopes,
    refreshToken: account.refreshToken,
  });
  return { redirectTo: `/accounts?connected=${connectionId}` };
}

/** The user's connection with this id, whose account a reconnect asks for. */
export async function connectionToReconnect(
  db: DbOrTx,
  userId: string,
  connectionId: string | null,
) {
  if (!connectionId) return undefined;
  const [connection] = await db
    .select({
      domain: connections.domain,
      externalEmail: connections.externalEmail,
    })
    .from(connections)
    .where(
      and(eq(connections.id, connectionId), eq(connections.userId, userId)),
    );
  return connection;
}
