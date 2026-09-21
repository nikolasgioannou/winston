import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { google, verifyGoogleIdToken } from "better-auth/social-providers";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type AuthConfig = {
  baseURL: string;
  webOrigin: string;
  ownerEmail: string;
  secret: string;
  clientId: string;
  clientSecret: string;
};

export function createOwnerAuth(config: AuthConfig, connectionString: string) {
  if (!config.ownerEmail.trim() || config.secret.length < 32) {
    throw new Error("Owner authentication requires an email allowlist and a strong secret.");
  }

  const ownerEmail = config.ownerEmail.trim().toLowerCase();
  const pool = new Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 540,
    query_timeout: 30_000,
    application_name: "winston_auth",
  });
  pool.on("error", () => {
    console.error("Authentication database connection lost.");
  });

  const database = drizzle(pool, { schema });
  const allowed = (email: string, verified: boolean) =>
    verified && email.toLowerCase() === ownerEmail;

  function requireOwner(email: string, verified: boolean) {
    if (!allowed(email, verified)) {
      throw new APIError("FORBIDDEN", { message: "Sign-in is not available for this account." });
    }
  }

  const googleIdentity = google({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    mapProfileToUser(profile) {
      // Runs on returning OAuth logins as well as first-time registration.
      requireOwner(profile.email, profile.email_verified);

      return { email: profile.email.toLowerCase() };
    },
  });

  const auth = betterAuth({
    appName: "Winston",
    baseURL: config.baseURL,
    secret: config.secret,
    database: drizzleAdapter(database, { provider: "pg", schema, transaction: true }),
    trustedOrigins: [config.webOrigin],
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      useSecureCookies: new URL(config.baseURL).protocol === "https:",
    },
    logger: { disabled: true },
    onAPIError: {
      onError: () => {
        console.error("Authentication request failed.");
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        accessType: "online",
        includeGrantedScopes: false,
        prompt: "select_account",
        async getUserInfo(tokens) {
          if (
            !tokens.idToken ||
            !(await verifyGoogleIdToken({
              token: tokens.idToken,
              audience: config.clientId,
              nonce:
                "expectedIdTokenNonce" in tokens && typeof tokens.expectedIdTokenNonce === "string"
                  ? tokens.expectedIdTokenNonce
                  : undefined,
            }))
          ) {
            return null;
          }

          return googleIdentity.getUserInfo(tokens);
        },
      },
    },
    account: {
      accountLinking: { enabled: false },
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      storeAccountCookie: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    databaseHooks: {
      user: {
        create: {
          before(user) {
            requireOwner(user.email, user.emailVerified);

            return Promise.resolve({ data: user });
          },
        },
      },
      session: {
        create: {
          async before(session, context) {
            const user = await context?.context.internalAdapter.findUserById(session.userId);

            if (!user) {
              return false;
            }

            requireOwner(user.email, user.emailVerified);

            return { data: session };
          },
        },
      },
    },
  });

  const routes = new Map([
    ["/api/auth/sign-in/social", "POST"],
    ["/api/auth/callback/google", "GET"],
    ["/api/auth/get-session", "GET"],
    ["/api/auth/sign-out", "POST"],
    ["/api/auth/error", "GET"],
  ]);

  return {
    async handle(request: Request) {
      const path = new URL(request.url).pathname;

      if (request.method === "POST" && request.headers.get("Origin") !== config.webOrigin) {
        return new Response(null, { status: 403 });
      }

      if (routes.get(path) !== request.method) {
        return new Response(null, { status: 404 });
      }

      if (path === "/api/auth/sign-in/social") {
        // Scope escalation and alternate login providers are not client-controlled.
        request = new Request(request, {
          body: JSON.stringify({
            provider: "google",
            callbackURL: config.webOrigin,
            errorCallbackURL: config.webOrigin,
          }),
          headers: new Headers(request.headers),
        });
        request.headers.set("Content-Type", "application/json");
        request.headers.delete("Content-Length");
      }

      if (path === "/api/auth/get-session") {
        const session = await auth.api.getSession({ headers: request.headers });

        if (session && !allowed(session.user.email, session.user.emailVerified)) {
          return Response.json(null);
        }
      }

      const response = await auth.handler(request);

      return response.status >= 500
        ? Response.json({ error: "Authentication is temporarily unavailable." }, { status: 503 })
        : response;
    },
    async owner(request: Request) {
      const session = await auth.api.getSession({ headers: request.headers });

      return session && allowed(session.user.email, session.user.emailVerified)
        ? { ownerId: session.user.id }
        : null;
    },
    close: () => pool.end(),
  };
}
