import { describe, expect, test } from "bun:test";
import {
  codeChallenge,
  exchangeGoogleCode,
  googleAuthorizationUrl,
  GoogleSignInError,
  type GoogleClaims,
} from "./google.server";

const client = {
  clientId: "client-123.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "http://localhost:3002/auth/google/callback",
};
const now = Date.parse("2026-09-28T12:00:00Z");

/** An unsigned ID token carrying `claims`, as Google's token endpoint returns it. */
export function idToken(claims: Record<string, unknown>) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

export const goodClaims: GoogleClaims = {
  iss: "https://accounts.google.com",
  aud: client.clientId,
  // Valid for an hour from the real clock, since the full callback checks it against now.
  exp: Math.floor(Date.now() / 1000) + 3600,
  sub: "google-sub-1",
  email: "Ada@Example.com",
  email_verified: true,
  given_name: "Ada",
  family_name: "Lovelace",
};

/** A fake token endpoint answering with `body`, recording what it was sent. */
export function fakeGoogle(body: unknown, status = 200) {
  const sent: URLSearchParams[] = [];
  const fetch = ((_url: string, init?: RequestInit) => {
    sent.push(new URLSearchParams(init?.body as URLSearchParams));
    return Promise.resolve(Response.json(body, { status }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

describe("googleAuthorizationUrl", () => {
  test("asks for identity only, with PKCE and the state", () => {
    const url = new URL(
      googleAuthorizationUrl(client, { state: "st", codeVerifier: "ver" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      scope: "openid email profile",
      state: "st",
      code_challenge: codeChallenge("ver"),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });

  test("the PKCE challenge is the verifier's SHA-256, base64url (RFC 7636's example)", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("exchangeGoogleCode", () => {
  const exchange = (
    claims: Record<string, unknown>,
    options: { status?: number } = {},
  ) => {
    const google = fakeGoogle({ id_token: idToken(claims) }, options.status);
    return {
      google,
      result: exchangeGoogleCode(
        client,
        { code: "code-1", codeVerifier: "ver" },
        { fetch: google.fetch, now },
      ),
    };
  };

  test("sends the code with the verifier and client, and returns the claims", async () => {
    const { google, result } = exchange(goodClaims);
    expect((await result).sub).toBe("google-sub-1");
    expect(Object.fromEntries(google.sent[0] ?? [])).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      code_verifier: "ver",
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
    });
  });

  test.each([
    ["a different issuer", { iss: "https://evil.example" }],
    ["a different audience", { aud: "someone-else" }],
    ["an expired token", { exp: now / 1000 - 1 }],
    ["an unverified email", { email_verified: false }],
    ["no subject", { sub: "" }],
  ])("rejects %s", async (_name, change) => {
    const error = await exchange({ ...goodClaims, ...change }).result.catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleSignInError);
  });

  test("rejects an error from the token endpoint, and a response without an ID token", async () => {
    const failed = await exchangeGoogleCode(
      client,
      { code: "c", codeVerifier: "v" },
      { fetch: fakeGoogle({ error: "invalid_grant" }, 400).fetch, now },
    ).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(GoogleSignInError);
    const empty = await exchangeGoogleCode(
      client,
      { code: "c", codeVerifier: "v" },
      { fetch: fakeGoogle({ access_token: "x" }).fetch, now },
    ).catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(GoogleSignInError);
  });
});
