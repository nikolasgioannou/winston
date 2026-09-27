import { snakeCase, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Every system prompt + tool definitions ever used, stored once and keyed by
 * their content hash, so each model call records exactly what the model saw.
 */
export const promptVersions = snakeCase.table("prompt_versions", {
  hash: text().primaryKey(),
  name: text().notNull(),
  content: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
