import {
  integer,
  pgEnum,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

/** Run lifecycle (docs/design.md §17). More states arrive with background runs. */
export const runStatus = pgEnum("run_status", [
  "running",
  "completed",
  "failed",
]);

/** One agent run. Today: one front-of-house turn. */
export const runs = snakeCase.table("runs", {
  id: text()
    .primaryKey()
    .$default(() => newId("frontRun")),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  status: runStatus().notNull().default("running"),
  stepCount: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp({ withTimezone: true }),
});
