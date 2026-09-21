import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "bun:test";
import { createOwnerAuth } from "@winston/adapters/auth";
import { migrateDatabase } from "@winston/adapters/database";
import { withTestPostgres } from "../../src/postgres";

const config = {
  baseURL: "http://127.0.0.1:3001",
  webOrigin: "http://127.0.0.1:5173",
  ownerEmail: "owner@example.com",
  secret: "a-test-only-secret-with-more-than-thirty-two-characters",
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
};

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

test("Google sign-in validates identity, state, sessions, origins, and scope boundaries", async () => {
  await withTestPostgres(async (sql, connectionString) => {
    await migrateDatabase(connectionString);
    const auth = createOwnerAuth(config, connectionString);
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = {
      ...publicKey.export({ format: "jwk" }),
      kid: "fixture",
      alg: "RS256",
      use: "sig",
    };
    let idToken = "";
    let tokenRequests = 0;
    const originalFetch = globalThis.fetch;

    // Exercise the real OAuth code exchange and JWT verification without contacting Google.
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url === "https://www.googleapis.com/oauth2/v3/certs") {
          return Promise.resolve(Response.json({ keys: [key] }));
        }

        if (url === "https://oauth2.googleapis.com/token") {
          tokenRequests += 1;

          return Promise.resolve(
            Response.json({
              access_token: "synthetic-access-token",
              token_type: "Bearer",
              expires_in: 3600,
              id_token: idToken,
            }),
          );
        }

        throw new Error("Unexpected outbound request in the OAuth fixture.");
      },
      { preconnect: originalFetch.preconnect },
    );

    async function start() {
      const response = await auth.handle(
        new Request(`${config.baseURL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: config.webOrigin },
          body: JSON.stringify({ provider: "google", scopes: ["https://mail.google.com/"] }),
        }),
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { url: string };
      const url = new URL(body.url);
      assert.equal(url.origin, "https://accounts.google.com");
      assert.ok(!url.searchParams.get("scope")?.includes("mail.google.com"));
      assert.equal(
        url.searchParams.get("redirect_uri"),
        `${config.baseURL}/api/auth/callback/google`,
      );
      assert.notEqual(url.searchParams.get("include_granted_scopes"), "true");
      assert.equal(url.searchParams.get("access_type"), "online");

      return { url, cookie: cookieHeader(response) };
    }

    async function finish(email: string, verified = true, validSignature = true) {
      const flow = await start();
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: "https://accounts.google.com",
        aud: config.clientId,
        sub: "owner-google-subject",
        email,
        email_verified: verified,
        name: "Fixture User",
        iat: now,
        exp: now + 3600,
        nonce: flow.url.searchParams.get("nonce"),
      };
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString(
        "base64url",
      );
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const content = `${header}.${body}`;
      idToken = `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;

      if (!validSignature) {
        idToken = `${content}.invalid-signature`;
      }
      const state = flow.url.searchParams.get("state");
      assert.ok(state);
      const url = `${config.baseURL}/api/auth/callback/google?code=fixture&state=${state}`;
      const request = new Request(url, { headers: { Cookie: flow.cookie } });
      const response = await auth.handle(request);

      return { response, request: new Request(url, { headers: { Cookie: flow.cookie } }) };
    }

    try {
      const forbidden = await auth.handle(
        new Request(`${config.baseURL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { Origin: "https://untrusted.example" },
          body: "{}",
        }),
      );
      assert.equal(forbidden.status, 403);
      assert.equal(
        (await auth.handle(new Request(`${config.baseURL}/api/auth/list-accounts`))).status,
        404,
      );

      for (const [email, verified] of [
        ["other@example.com", true],
        [config.ownerEmail, false],
      ] as const) {
        const { response } = await finish(email, verified);
        assert.ok(!cookieHeader(response).includes("session_token="));
      }

      const invalidToken = await finish(config.ownerEmail, true, false);
      assert.ok(!cookieHeader(invalidToken.response).includes("session_token="));

      const missingCookieFlow = await start();
      const missingCookieUrl = new URL(`${config.baseURL}/api/auth/callback/google`);
      missingCookieUrl.searchParams.set("code", "fixture");
      missingCookieUrl.searchParams.set(
        "state",
        missingCookieFlow.url.searchParams.get("state") ?? "",
      );
      const callsBeforeMissingCookie = tokenRequests;
      const missingCookie = await auth.handle(new Request(missingCookieUrl.href));
      assert.ok(!cookieHeader(missingCookie).includes("session_token="));
      assert.equal(tokenRequests, callsBeforeMissingCookie);

      const [empty] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM winston_auth.users`;
      assert.equal(empty?.count, 0);

      const { response, request } = await finish(config.ownerEmail);
      assert.equal(response.status, 302);
      const cookie = cookieHeader(response);
      assert.ok(cookie.includes("session_token="), await response.text());
      const ownerRequest = new Request(`${config.baseURL}/api/owner/session`, {
        headers: { Cookie: cookie },
      });
      const owner = await auth.owner(ownerRequest);
      assert.ok(owner?.ownerId);
      assert.equal(await auth.owner(new Request(ownerRequest.url)), null);

      const callsBeforeReplay = tokenRequests;
      const replay = await auth.handle(request);
      assert.ok(!cookieHeader(replay).includes("session_token="));
      assert.equal(tokenRequests, callsBeforeReplay);

      // A returning provider identity must still match the allowlist today.
      const changedGoogleIdentity = await finish("other@example.com");
      assert.ok(!cookieHeader(changedGoogleIdentity.response).includes("session_token="));

      await sql`UPDATE winston_auth.users SET email_verified = false WHERE id = ${owner.ownerId}`;
      assert.equal(await auth.owner(ownerRequest), null);
      const session = await auth.handle(
        new Request(`${config.baseURL}/api/auth/get-session`, { headers: { Cookie: cookie } }),
      );
      assert.equal(await session.json(), null);
      await sql`UPDATE winston_auth.users SET email_verified = true WHERE id = ${owner.ownerId}`;

      const logout = await auth.handle(
        new Request(`${config.baseURL}/api/auth/sign-out`, {
          method: "POST",
          headers: { Cookie: cookie, Origin: config.webOrigin, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      assert.equal(logout.status, 200);
      assert.equal(await auth.owner(ownerRequest), null);
      const [stored] = await sql<
        { token: string }[]
      >`SELECT access_token AS token FROM winston_auth.accounts LIMIT 1`;
      assert.ok(stored?.token);
      assert.notEqual(stored.token, "synthetic-access-token");
    } finally {
      globalThis.fetch = originalFetch;
      await auth.close();
    }
  });
});
