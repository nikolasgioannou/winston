import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";

export const users = snakeCase.table("users", {
  id: text()
    .primaryKey()
    .$default(() => newId("user")),
  email: text().notNull().unique(),
  /**
   * Google's stable account id (the ID token's `sub`). Emails can be
   * reassigned; this can't. Set at first sign-in.
   */
  googleSub: text().unique(),
  firstName: text().notNull(),
  lastName: text().notNull(),
  /** IANA time zone, e.g. `America/New_York`. */
  timezone: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Set when the user asks to delete their account; the `delete_user` job
   * then removes the row. Such a user can't sign in meanwhile.
   */
  deletionRequestedAt: timestamp({ withTimezone: true }),
});
