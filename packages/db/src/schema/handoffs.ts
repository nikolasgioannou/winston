import {
  index,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
 * A browser window handed to the user (docs/design.md §5, §17): a link to a
 * live view of that one tab. `open` once the link is made; `connected` when
 * the page opens it, which uses the token up; `resolved` when the task
 * carries on; `expired` if nobody opens it in time. Only hashes are stored.
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
    tokenHash: text().notNull(),
    /** The connected page's own secret, so it can reconnect after a drop. */
    viewerSecretHash: text(),
    connectDeadline: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex().on(t.tokenHash),
    index().on(t.runId),
    index().on(t.userId, t.status),
  ],
);
