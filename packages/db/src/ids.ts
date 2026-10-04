import { createId } from "@winston/shared/ids";

/**
 * Every entity's id prefix, in one place so they stay unique. Each table's
 * schema file uses `newId` with its own entity kind.
 */
export const idPrefixes = {
  user: "usr",
  frontRun: "run",
  /** A background run: the task the CLI names (`winston task`). */
  task: "task",
  /** A schedule or subscription Winston set for himself (§3). */
  trigger: "trg",
  /** A live-view link handing a browser window to the user (§5). */
  handoff: "hnd",
  /** A provider event, before matching subscriptions (§3). */
  event: "evn",
  /** Inbound items and outbound messages together form the history (`hist_`). */
  historyItem: "hist",
  vm: "vm",
  file: "file",
  webSession: "ses",
  connection: "acct",
  // Provider objects the CLI names (external_refs).
  message: "msg",
  thread: "thr",
  draft: "drf",
  attachment: "att",
  calendarEvent: "evt",
  /** Winston's own mailbox's messages and threads, as its provider stores them. */
  mailboxMessage: "wmsg",
  mailboxThread: "wthr",
  /** A call to Jev, the browser's fast decision model (§5). */
  jevDecision: "jev",
} as const;

export type EntityKind = keyof typeof idPrefixes;

/** Creates a new id for an entity, e.g. `newId("user")` → `usr_…`. */
export function newId<const Kind extends EntityKind>(kind: Kind) {
  return createId(idPrefixes[kind]);
}
