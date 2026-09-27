import { bigint, snakeCase, text } from "drizzle-orm/pg-core";
import { users } from "./users.ts";

/** Per-user front-of-house state: where the rolling window starts. */
export const frontState = snakeCase.table("front_state", {
  userId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** First `run_messages.id` in the window; 0 means from the beginning. */
  windowStartMessageId: bigint({ mode: "number" }).notNull().default(0),
});
