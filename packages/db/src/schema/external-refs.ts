import {
  pgEnum,
  snakeCase,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { connections } from "./connections.ts";
import { users } from "./users.ts";

/** The kinds of provider object the CLI names, with their id prefixes in ../ids.ts. */
export const externalRefKind = pgEnum("external_ref_kind", [
  "message",
  "thread",
  "draft",
  "attachment",
  "calendarEvent",
]);

/**
 * CLI ids for provider objects (docs/design.md §11, Identifiers): a typed id
 * like `msg_…` stands for one object in one connection. The first time an
 * object is shown it gets an id; showing it again reuses it, so ids stay
 * stable and any of them resolves back (`winston get`). Provider ids can't be
 * encoded into TypeIDs (their suffix is a UUID), hence the table.
 */
export const externalRefs = snakeCase.table(
  "external_refs",
  {
    /** `msg_…`, `thr_…`, `drf_…`, `att_…` or `evt_…`. */
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: text()
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    kind: externalRefKind().notNull(),
    /** The provider's id: a Gmail message id, a calendar event's `<calendar>/<event>`. */
    providerId: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.connectionId, t.kind, t.providerId)],
);
