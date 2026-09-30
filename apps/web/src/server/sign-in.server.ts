/**
 * What happens when Google sends someone back (docs/design.md §5, §9): the
 * allowlist is checked before anything is created, then the user is found
 * (by Google account, then by email) or created, their computer is
 * requested if they don't have one yet, and a session starts.
 */
import type { DbOrTx } from "@winston/db/client";
import { allowedEmails, users } from "@winston/db/schema";
import { requestVm } from "@winston/db/vms";
import { createSession } from "@winston/db/web-sessions";
import { tokenMatches, hashToken } from "@winston/shared/tokens";
import { eq, sql } from "drizzle-orm";
import {
  exchangeGoogleCode,
  GoogleAuthError,
  type GoogleClaims,
  type GoogleClient,
} from "./google.server";

/** Why sign-in didn't work, as the sign-in page (/) shows it. */
export type SignInProblem = "not_allowlisted" | "oauth";

export type SignInResult =
  | { outcome: "signed_in"; userId: string; created: boolean }
  | { outcome: "problem"; problem: SignInProblem };

/**
 * Signs in the Google account in `claims`. Unknown emails are turned away
 * before any user (or computer) exists. An email already tied to a different
 * Google account is refused too, since emails can be reassigned. A user
 * without a computer gets one requested in the same transaction (§17), which
 * covers sign-up and users who existed before it, like the dev seed's.
 */
export async function signInWithGoogle(
  db: DbOrTx,
  claims: GoogleClaims,
  browserTimezone: string | undefined,
): Promise<SignInResult> {
  return db.transaction(async (tx) => {
    const result = await findOrCreateUser(tx, claims, browserTimezone);
    if (result.outcome === "signed_in") await requestVm(tx, result.userId);
    return result;
  });
}

async function findOrCreateUser(
  db: DbOrTx,
  claims: GoogleClaims,
  browserTimezone: string | undefined,
): Promise<SignInResult> {
  const email = claims.email.toLowerCase();
  const [allowed] = await db
    .select({ email: allowedEmails.email })
    .from(allowedEmails)
    .where(eq(sql`lower(${allowedEmails.email})`, email));
  if (!allowed) return { outcome: "problem", problem: "not_allowlisted" };

  const [bySub] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.googleSub, claims.sub));
  if (bySub) return { outcome: "signed_in", userId: bySub.id, created: false };

  const [byEmail] = await db
    .select({ id: users.id, googleSub: users.googleSub })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email));
  if (byEmail) {
    if (byEmail.googleSub !== null)
      return { outcome: "problem", problem: "oauth" };
    await db
      .update(users)
      .set({ googleSub: claims.sub })
      .where(eq(users.id, byEmail.id));
    return { outcome: "signed_in", userId: byEmail.id, created: false };
  }

  const [created] = await db
    .insert(users)
    .values({
      email,
      googleSub: claims.sub,
      firstName: claims.given_name ?? claims.name ?? email.split("@")[0] ?? "",
      lastName: claims.family_name ?? "",
      timezone: validTimezone(browserTimezone) ?? "UTC",
    })
    .returning({ id: users.id });
  if (!created) throw new Error("Creating a user returned no row.");
  return { outcome: "signed_in", userId: created.id, created: true };
}

/** An IANA time zone the runtime knows, or undefined. */
export function validTimezone(timezone: string | undefined) {
  if (!timezone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return undefined;
  }
}

/** The short-lived values the sign-in flow keeps in cookies between the two redirects. */
export interface FlowCookies {
  state: string | undefined;
  codeVerifier: string | undefined;
  timezone: string | undefined;
}

export type CallbackResult =
  | { redirectTo: "/home"; sessionToken: string; userId: string }
  | { redirectTo: `/?error=${SignInProblem}` };

/**
 * Handles Google's redirect back: checks the state against the one set when
 * the flow began, exchanges the code, signs in and starts a session.
 */
export async function completeGoogleSignIn(
  deps: { db: DbOrTx; google: GoogleClient; fetch?: typeof fetch },
  query: URLSearchParams,
  cookies: FlowCookies,
): Promise<CallbackResult> {
  const problem = (p: SignInProblem) =>
    ({ redirectTo: `/?error=${p}` }) as const;
  const code = query.get("code");
  const state = query.get("state");
  // Google reports a cancelled or failed consent as ?error=…
  if (query.get("error") || !code || !state) return problem("oauth");
  if (
    !cookies.state ||
    !cookies.codeVerifier ||
    !tokenMatches(state, hashToken(cookies.state))
  )
    return problem("oauth");

  let claims: GoogleClaims;
  try {
    claims = await exchangeGoogleCode(
      deps.google,
      { code, codeVerifier: cookies.codeVerifier },
      deps.fetch ? { fetch: deps.fetch } : {},
    );
  } catch (error) {
    if (error instanceof GoogleAuthError) return problem("oauth");
    throw error;
  }

  const result = await signInWithGoogle(deps.db, claims, cookies.timezone);
  if (result.outcome === "problem") return problem(result.problem);
  const { token } = await createSession(deps.db, result.userId);
  return { redirectTo: "/home", sessionToken: token, userId: result.userId };
}
