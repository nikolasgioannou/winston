import { createHash, createHmac } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { providerGrantSchema, type ProviderGrant } from "@winston/contracts/credentials";
import { GoogleAccessError } from "./errors";
import {
  googleGrantSchema,
  googleOAuthErrorSchema,
  googleIdentitySchema,
  googleScopes,
  type GoogleService,
  type GoogleGrant,
} from "@winston/contracts/connections";

export type GoogleOAuth = {
  url(service: GoogleService, state: string): string;
  exchange(code: string, state: string, signal: AbortSignal): Promise<GoogleGrant>;
  refresh(grant: ProviderGrant, signal: AbortSignal): Promise<ProviderGrant>;
};

export function createGoogleOAuth(config: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): GoogleOAuth {
  const derive = (kind: string, state: string) =>
    createHmac("sha256", config.clientSecret).update(`${kind}:${state}`).digest("base64url");
  function client(signal?: AbortSignal) {
    const oauth = new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
    // The library enables POST retries itself; override per request to avoid replaying one-time codes.
    oauth.transporter.interceptors.request.add({
      resolved: (request) => {
        request.retry = false;
        request.retryConfig = { retry: 0 };
        request.timeout = 15_000;
        if (signal) request.signal = signal;
        return Promise.resolve(request);
      },
    });
    return oauth;
  }
  return {
    async refresh(grant, signal) {
      try {
        const oauth = client(AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
        oauth.setCredentials({ refresh_token: grant.refreshToken });
        let rotatedRefreshToken: string | undefined;
        oauth.on("tokens", (tokens) => {
          // Capture before the library restores the old refresh token on its result object.
          if (tokens.refresh_token) rotatedRefreshToken = tokens.refresh_token;
        });
        const { credentials } = await oauth.refreshAccessToken();
        return providerGrantSchema.parse({
          accessToken: credentials.access_token,
          refreshToken: rotatedRefreshToken ?? grant.refreshToken,
          expiresAt: new Date(credentials.expiry_date ?? 0).toISOString(),
          scopes: credentials.scope?.split(" ").filter(Boolean) ?? grant.scopes,
        });
      } catch (error) {
        const parsed = googleOAuthErrorSchema.safeParse(error);
        throw new GoogleAccessError(
          parsed.success && parsed.data.response.data.error === "invalid_grant"
            ? "reconnect"
            : "unavailable",
        );
      }
    },
    url(service, state) {
      const url = new URL(
        client().generateAuthUrl({
          access_type: "offline",
          prompt: "consent select_account",
          include_granted_scopes: false,
          scope: [
            "openid",
            "email",
            ...googleScopes[service],
            ...(service === "calendar"
              ? ["https://www.googleapis.com/auth/calendar.events.freebusy"]
              : []),
          ],
          state,
          code_challenge_method: CodeChallengeMethod.S256,
          code_challenge: createHash("sha256").update(derive("pkce", state)).digest("base64url"),
        }),
      );
      url.searchParams.set("nonce", derive("nonce", state));
      return url.href;
    },
    async exchange(code, state, signal) {
      try {
        const oauth = client(AbortSignal.any([signal, AbortSignal.timeout(45_000)]));
        const { tokens } = await oauth.getToken({ code, codeVerifier: derive("pkce", state) });
        if (!tokens.id_token || !tokens.access_token || !tokens.expiry_date) throw new Error();
        const ticket = await oauth.verifyIdToken({
          idToken: tokens.id_token,
          audience: config.clientId,
        });
        const identity = googleIdentitySchema.parse(ticket.getPayload());
        if (
          identity.nonce !== derive("nonce", state) ||
          (identity.azp && identity.azp !== config.clientId)
        )
          throw new Error();
        const scopes =
          tokens.scope?.split(" ").filter(Boolean) ??
          (await oauth.getTokenInfo(tokens.access_token)).scopes;
        return googleGrantSchema.parse({
          subject: identity.sub,
          email: identity.email,
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          expiresAt: new Date(tokens.expiry_date).toISOString(),
          scopes,
        });
      } catch {
        throw new Error(
          "Google connection could not be completed. Start a new connection attempt.",
        );
      }
    },
  };
}
