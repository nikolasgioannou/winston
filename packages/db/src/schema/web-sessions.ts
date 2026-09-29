import { index, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

/**
 * Signed-in browser sessions (docs/design.md §9, Auth). The raw token lives
 * only in the user's HTTP-only cookie; the row keeps its hash.
 */
export const webSessions = snakeCase.table(
  "web_sessions",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("webSession")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  // Cleanup deletes by expiry; sign-out-everywhere and deletion go by user.
  (t) => [index().on(t.expiresAt), index().on(t.userId)],
);
