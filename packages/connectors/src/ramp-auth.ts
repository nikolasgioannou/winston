/**
 * Ramp's OAuth for Ramp MCP (8f6c44, docs/research/ramp-mcp.md "Verified"):
 * Authorization Code with PKCE, a public client (no secret) registered once
 * per environment through dynamic registration. Ramp's refresh tokens rotate
 * (`rotatingAccessTokens`), and a public client can't revoke.
 */
import { rampConnectScopes } from "@winston/domain/connections";
import { codeChallenge } from "@winston/shared/tokens";
import { z } from "zod";
import { mcpClient } from "./mcp.ts";
import type { RefreshTokens } from "./rotating-tokens.ts";

/** Ramp's MCP server, which is also the resource tokens are for. */
export const rampMcpUrl = "https://mcp.ramp.com/mcp";
const authorizeEndpoint = "https://mcp.ramp.com/oauth/authorize";
const tokenEndpoint = "https://api.ramp.com/developer/v1/token/pkce";

/** This environment's registered client and where Ramp sends the browser back. */
export interface RampClient {
  clientId: string;
  redirectUri: string;
}

/** Ramp refused the code or answered in a way we can't use. */
export class RampAuthError extends Error {
  override name = "RampAuthError";
}

/** Where to send the browser to connect a Ramp account. */
export function rampConnectUrl(
  client: RampClient,
  { state, codeVerifier }: { state: string; codeVerifier: string },
) {
  const url = new URL(authorizeEndpoint);
  // Ramp's own `auth_level=auto` comes first, as in its metadata.
  url.searchParams.set("auth_level", "auto");
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    scope: rampConnectScopes.join(" "),
    state,
    code_challenge: codeChallenge(codeVerifier),
    code_challenge_method: "S256",
    resource: rampMcpUrl,
  }))
    url.searchParams.set(name, value);
  return url.toString();
}

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string().default(""),
});

async function tokenRequest(
  params: Record<string, string>,
  send: typeof fetch,
) {
  const response = await send(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) return { error: body.error ?? String(response.status) };
  return { tokens: tokenSchema.parse(body) };
}

/** Trades the authorization code for tokens. */
export async function exchangeRampCode(
  client: RampClient,
  { code, codeVerifier }: { code: string; codeVerifier: string },
  send: typeof fetch = fetch,
) {
  const result = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: codeVerifier,
      resource: rampMcpUrl,
    },
    send,
  );
  if (!result.tokens)
    throw new RampAuthError(`Ramp refused the code: ${result.error}`);
  const { access_token, refresh_token, scope } = result.tokens;
  if (!refresh_token) throw new RampAuthError("Ramp gave no refresh token.");
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    scopes: scope.split(" ").filter(Boolean),
  };
}

/** Refreshes at Ramp, for `rotatingAccessTokens`. */
export function rampTokenRefresher(
  clientId: string,
  send: typeof fetch = fetch,
): RefreshTokens {
  return async (refreshToken) => {
    const result = await tokenRequest(
      {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      },
      send,
    );
    if (result.error === "invalid_grant") return "invalid_grant";
    if (!result.tokens)
      throw new Error(`Refreshing a Ramp token failed: ${result.error}`);
    return {
      accessToken: result.tokens.access_token,
      expiresIn: result.tokens.expires_in,
      ...(result.tokens.refresh_token
        ? { refreshToken: result.tokens.refresh_token }
        : {}),
    };
  };
}

const userDetailSchema = z.object({
  users: z.array(z.object({ email: z.string() })).min(1),
});

/** The signed-in Ramp user's email, which names the connection. */
export async function rampUserEmail(
  accessToken: string,
  send: typeof fetch = fetch,
) {
  const text = await mcpClient({
    url: rampMcpUrl,
    accessToken: () => Promise.resolve(accessToken),
    fetch: send,
  }).callTool("ramp_get_simplified_user_detail", {
    rationale: "Find out which Ramp user just connected to Winston.",
  });
  const parsed = userDetailSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new RampAuthError("Ramp didn't say who signed in.");
  const [user] = parsed.data.users;
  return (user?.email ?? "").trim().toLowerCase();
}
