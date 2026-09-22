import { createHash, createHmac } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import {
  googleGrantSchema,
  googleIdentitySchema,
  googleScopes,
  type GoogleService,
  type GoogleGrant,
} from "@winston/contracts/connections";

export type GoogleOAuth = {
  url(service: GoogleService, state: string): string;
  exchange(code: string, state: string, signal: AbortSignal): Promise<GoogleGrant>;
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
    url(service, state) {
      const url = new URL(
        client().generateAuthUrl({
          access_type: "offline",
          prompt: "consent select_account",
          include_granted_scopes: false,
          scope: ["openid", "email", ...googleScopes[service]],
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
