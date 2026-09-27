import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";

/** Google accounts allowed to sign up or sign in. */
export const allowedEmails = snakeCase.table("allowed_emails", {
  email: text().primaryKey(),
  addedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
