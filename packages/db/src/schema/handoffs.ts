import { index, pgEnum, snakeCase, text, timestamp } from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { runs } from "./runs.ts";
import { users } from "./users.ts";

export const handoffStatus = pgEnum("handoff_status", [
  "open",
  "connected",
  "resolved",
  "expired",
]);

/**
 * A browser window handed to the user (docs/design.md §5, §17): `open`
 * while they have it, `resolved` once control goes back. Rows from before
 * the signed-in browser page (b8e28a) can also be `connected` or `expired`,
 * from when each handoff had its own single-use link.
 */
export const handoffs = snakeCase.table(
  "handoffs",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("handoff")),
    runId: text()
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The window's `win_` id and its CDP target on the VM. */
    windowId: text().notNull(),
    targetId: text().notNull(),
    reason: text().notNull(),
    status: handoffStatus().notNull().default("open"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.runId), index().on(t.userId, t.status)],
);
