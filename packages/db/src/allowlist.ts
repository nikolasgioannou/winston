import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "./client.ts";
import { allowedEmails, users } from "./schema/index.ts";

/** An email as the allowlist stores it: trimmed and lowercase, or undefined if it isn't one. */
export function normalizeEmail(input: string) {
  const email = input.trim().toLowerCase();
  return z.email().safeParse(email).success ? email : undefined;
}

/** Allows an email to sign in. Returns false if it already could. */
export async function allowEmail(db: DbOrTx, email: string) {
  const added = await db
    .insert(allowedEmails)
    .values({ email })
    .onConflictDoNothing()
    .returning({ email: allowedEmails.email });
  return added.length > 0;
}

/**
 * Stops an email from signing in. An existing account stays (only its owner
 * deletes it). Returns whether it was listed and whether an account exists.
 */
export async function disallowEmail(db: DbOrTx, email: string) {
  const removed = await db
    .delete(allowedEmails)
    .where(eq(allowedEmails.email, email))
    .returning({ email: allowedEmails.email });
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return { wasListed: removed.length > 0, hasAccount: account !== undefined };
}

/** The allowlist, oldest first. */
export async function listAllowedEmails(db: DbOrTx) {
  return db
    .select({ email: allowedEmails.email, addedAt: allowedEmails.addedAt })
    .from(allowedEmails)
    .orderBy(asc(allowedEmails.addedAt));
}
