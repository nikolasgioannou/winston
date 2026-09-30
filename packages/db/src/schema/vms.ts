import {
  index,
  integer,
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
  /** Where it runs. Set when provisioning starts: the service that provisions decides. */
  provider: vmProvider(),
  /** The container or instance, once one exists. */
  instanceId: text(),
  dataVolumeId: text(),
  state: vmState().notNull().default("requested"),
  /** When `state` last changed, for timeouts (docs/design.md §17). */
  stateChangedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Setup failures since the VM was last ready, to limit automatic retries (§17). */
  setupFailures: integer().notNull().default(0),
  /** The long-lived VM token `winstond` holds, hashed (§15). Looked up by hash. */
  tokenHash: text().unique(),
  /** The one-time bootstrap token, hashed, until it's exchanged (§15). */
  registrationTokenHash: text().unique(),
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
