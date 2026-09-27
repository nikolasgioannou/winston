import {
  index,
  pgEnum,
  snakeCase,
  text,
  timestamp,
  bigint,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.ts";
import { users } from "./users.ts";

export const vmProvider = pgEnum("vm_provider", ["docker", "ec2"]);

/** The VM lifecycle (docs/design.md §17). Legal moves live in `vm-state.ts`. */
export const vmState = pgEnum("vm_state", [
  "requested",
  "provisioning",
  "registering",
  "ready",
  "unhealthy",
  "updating",
  "failed",
  "terminating",
  "terminated",
]);

/** Each user's computer: a local Docker container or an EC2 instance. */
export const vms = snakeCase.table("vms", {
  id: text()
    .primaryKey()
    .$default(() => newId("vm")),
  userId: text()
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: vmProvider().notNull(),
  /** The container or instance, once one exists. */
  instanceId: text(),
  dataVolumeId: text(),
  state: vmState().notNull().default("requested"),
  /** The long-lived VM token `winstond` holds, hashed (§15). */
  tokenHash: text(),
  /** The one-time bootstrap token, hashed, until it's exchanged (§15). */
  registrationTokenHash: text(),
  /** Versions `winstond` reports on connect. */
  cliVersion: text(),
  winstondVersion: text(),
  lastSeenAt: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Files that landed on a user's VM, such as Telegram attachments. */
export const files = snakeCase.table(
  "files",
  {
    id: text()
      .primaryKey()
      .$default(() => newId("file")),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vmPath: text().notNull(),
    mime: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    /** Set when the file came from (or went to) Telegram. */
    telegramFileId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
