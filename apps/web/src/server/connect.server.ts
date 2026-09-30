/**
 * Connecting a Google account (docs/design.md §12a): the site starts the
 * flow for the signed-in user and finishes it in the same session, so a
 * forwarded link can't attach someone else's account (the founder's call,
 * 2026-09-29: the callback lives in `web`, not `api`).
 */
import type { DbOrTx } from "@winston/db/client";
import { saveConnection } from "@winston/db/connections";
import { connections } from "@winston/db/schema";
import { and, eq } from "drizzle-orm";
import {
  connectionDomains,
  type ConnectionDomain,
} from "@winston/domain/connections";
import type { TokenVault } from "@winston/shared/token-vault";
import { hashToken, tokenMatches } from "@winston/shared/tokens";
import {
  connectGrants,
  exchangeGoogleConnectCode,
  GoogleAuthError,
  type GoogleClient,
} from "./google.server";

/** Where Google sends the browser back (registered on the OAuth client). */
export const connectCallbackPath = "/auth/google/connect/callback";

/** Why connecting didn't work, as `/accounts` shows it. */
export type ConnectProblem = "oauth" | "missing_scopes";

export type ConnectResult =
  | { redirectTo: `/accounts?connected=${string}` }
  | { redirectTo: `/accounts?error=${ConnectProblem}` };

/** The flow's values, kept in cookies between the two redirects. */
export interface ConnectCookies {
  state: string | undefined;
  codeVerifier: string | undefined;
  domain: string | undefined;
}

export const isConnectionDomain = (value: unknown): value is ConnectionDomain =>
  connectionDomains.includes(value as ConnectionDomain);

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
  const problem = (p: ConnectProblem) =>
    ({ redirectTo: `/accounts?error=${p}` }) as const;
  const code = query.get("code");
  const state = query.get("state");
  const domain = cookies.domain;
  // A cancelled consent comes back as ?error=access_denied.
  if (query.get("error") || !code || !state) return problem("oauth");
  if (
    !cookies.state ||
    !cookies.codeVerifier ||
    !isConnectionDomain(domain) ||
    !tokenMatches(state, hashToken(cookies.state))
  )
    return problem("oauth");

  let grant;
  try {
    grant = await exchangeGoogleConnectCode(
      deps.google,
      { code, codeVerifier: cookies.codeVerifier },
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

/** The user's connection with this id, whose account a reconnect asks Google for. */
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
