/**
 * The session cookie (docs/design.md §9, Auth): HttpOnly, SameSite=Lax (so
 * it survives the redirect back from Google), host-only on the site's own
 * domain, and Secure with the __Host- prefix when served over https.
 */
import { users } from "@winston/db/schema";
import {
  deleteSession,
  findSession,
  sessionLifetimeMs,
} from "@winston/db/web-sessions";
import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { webConfig } from "./config.server";
import { database } from "./db.server";

function secure() {
  return webConfig().WEB_PUBLIC_URL.startsWith("https:");
}

function sessionCookieName() {
  return secure() ? "__Host-winston_session" : "winston_session";
}

export function setSessionCookie(token: string) {
  setCookie(sessionCookieName(), token, {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax",
    path: "/",
    maxAge: sessionLifetimeMs / 1000,
  });
}

/** The signed-in user, if the request carries a live session. */
export async function currentUser() {
  const token = getCookie(sessionCookieName());
  if (!token) return undefined;
  const db = database();
  const session = await findSession(db, token);
  if (!session) return undefined;
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      timezone: users.timezone,
      browserTimezone: users.browserTimezone,
    })
    .from(users)
    .where(eq(users.id, session.userId));
  return user;
}

/**
 * The signed-in user, for private server functions; without a session it
 * sends the browser to sign in.
 */
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw redirect({ to: "/" });
  return user;
}

/** Signs out: deletes the session and clears the cookie. */
export async function endSession() {
  const token = getCookie(sessionCookieName());
  if (token) await deleteSession(database(), token);
  deleteCookie(sessionCookieName(), { path: "/" });
}

/** The cookies that carry the sign-in flow between the two redirects. */
export const flowCookieNames = {
  state: "winston_oauth_state",
  codeVerifier: "winston_oauth_verifier",
  timezone: "winston_oauth_tz",
  next: "winston_oauth_next",
} as const;

export function setFlowCookies(values: {
  state: string;
  codeVerifier: string;
  timezone: string | undefined;
  next: string | undefined;
}) {
  const options = {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax" as const,
    path: "/auth/google",
    maxAge: 600,
  };
  setCookie(flowCookieNames.state, values.state, options);
  setCookie(flowCookieNames.codeVerifier, values.codeVerifier, options);
  if (values.timezone)
    setCookie(flowCookieNames.timezone, values.timezone, options);
  if (values.next) setCookie(flowCookieNames.next, values.next, options);
}

/** The cookies that carry the connect flow between the two redirects. */
const connectCookieNames = {
  state: "winston_connect_state",
  codeVerifier: "winston_connect_verifier",
  domain: "winston_connect_domain",
} as const;
const connectCookiePath = "/auth/google/connect";

export function setConnectCookies(values: {
  state: string;
  codeVerifier: string;
  domain: string;
}) {
  const options = {
    httpOnly: true,
    secure: secure(),
    sameSite: "lax" as const,
    path: connectCookiePath,
    maxAge: 600,
  };
  for (const [key, name] of Object.entries(connectCookieNames))
    setCookie(name, values[key as keyof typeof values], options);
}

/** Reads the connect flow's cookies once and clears them. */
export function takeConnectCookies() {
  const values = {
    state: getCookie(connectCookieNames.state),
    codeVerifier: getCookie(connectCookieNames.codeVerifier),
    domain: getCookie(connectCookieNames.domain),
  };
  for (const name of Object.values(connectCookieNames))
    deleteCookie(name, { path: connectCookiePath });
  return values;
}

/** Reads the flow cookies once and clears them. */
export function takeFlowCookies() {
  const values = {
    state: getCookie(flowCookieNames.state),
    codeVerifier: getCookie(flowCookieNames.codeVerifier),
    timezone: getCookie(flowCookieNames.timezone),
    next: getCookie(flowCookieNames.next),
  };
  for (const name of Object.values(flowCookieNames))
    deleteCookie(name, { path: "/auth/google" });
  return values;
}

/** The Google client for this environment, redirecting back to `callbackPath` on the site. */
export function googleClient(callbackPath = "/auth/google/callback") {
  const config = webConfig();
  return {
    clientId: config.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL(callbackPath, config.WEB_PUBLIC_URL).toString(),
  };
}
