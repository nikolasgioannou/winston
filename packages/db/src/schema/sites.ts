import {
  boolean,
  integer,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

/** Who may open a site (docs/design.md §9a): its owner only, or also anyone with its share link. */
export const siteAccess = pgEnum("site_access", ["private", "link"]);

/**
 * A site Winston deployed, at `<name>.runwinston.app` (docs/design.md §9a).
 * Its Worker is named by its id; its routes-map entry by its name.
 */
export const sites = snakeCase.table("sites", {
  id: text()
    .primaryKey()
    .$default(() => newId("site")),
  userId: text()
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** One DNS label, first come first served across every user. */
  name: text().notNull().unique(),
  access: siteAccess().notNull().default("private"),
  /**
   * The share link's key while it's shared by link, kept so the link can be
   * shown again (the routes map holds only its hash). A new one each time
   * it's shared after being made private, so old links stop working.
   */
  shareKey: text(),
  paused: boolean().notNull().default(false),
  /** Its D1 database, created by the first deploy that has migrations. */
  databaseId: text(),
  /** The deployed version's number (`site_versions.number`). */
  currentVersion: integer(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Each deploy of a site: its bundle, kept in blob storage for rollback. */
export const siteVersions = snakeCase.table(
  "site_versions",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("siteVersion")),
    siteId: text()
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** 1, 2, 3… per site. */
    number: integer().notNull(),
    /** The bundle (a tar), as a blob key. */
    bundleKey: text().notNull(),
    /** The bundle's size in bytes. */
    size: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.siteId, t.number)],
);
