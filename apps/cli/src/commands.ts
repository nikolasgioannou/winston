import type { CliRequest } from "@winston/contracts/cli";

const gmailMessageHelp =
  " Message JSON requires from {email,name?}, to/cc/bcc arrays of mailboxes, subject, text, html (string or null), reply (null or {sourceMessageId,threadId,inReplyTo,references}), and attachments [{artifactId,revision,name,mediaType,size,sha256}]. Sender must match the selected account. Attachments must be owned, ready artifacts; paths and URLs are not accepted. Reuse the exact key and arguments after approval. Never resend an unknown outcome.";

export const commands = [
  {
    command: "gmail.trash",
    id: true,
    flags: ["account", "id", "key"],
    description:
      "Move one inspected message to Trash under its separate trash permission. No permanent deletion or whole-thread expansion. Source read and trash may each require approval; reuse the same key and arguments. Reconcile unknown results instead of retrying.",
    usage: "--account <uuid> --id <message-id> --key <stable-key>",
  },
  {
    command: "gmail.restore",
    id: true,
    flags: ["account", "id", "key"],
    description:
      "Remove one inspected message from Trash under its separate trash permission. Does not request a destination folder. Reuse the same key through approvals; reconcile unknown results instead of retrying.",
    usage: "--account <uuid> --id <message-id> --key <stable-key>",
  },
  {
    command: "gmail.modify",
    id: true,
    flags: ["account", "id", "key", "add-labels", "remove-labels"],
    description:
      "Change labels on one exact message. Label arrays contain IDs from gmail labels. Remove INBOX to archive, remove UNREAD to mark read, add UNREAD to mark unread, and add/remove STARRED to star/unstar. Does not expand to a thread. TRASH, SENT, DRAFT and draft/trashed messages are excluded. Source reads and changes may need separate approvals; reuse the exact key and arguments. Reconcile unknown results instead of retrying.",
    usage:
      "--account <uuid> --id <message-id> --key <stable-key> [--add-labels <JSON-array>] [--remove-labels <JSON-array>]",
  },
  {
    command: "gmail.labels",
    id: false,
    flags: ["account", "key"],
    description:
      "List label IDs, names and user/system types in the selected Gmail account under its read permission. Use a stable key when approval is required.",
    usage: "--account <uuid> [--key <read-key>]",
  },
  {
    command: "gmail.reconcile",
    id: true,
    flags: ["id", "key"],
    description:
      "Read evidence for an uncertain Gmail operation under current read permission. Never resends. Reuse the observation key after approval; use a fresh key only for a deliberate later observation. A matching result confirms observed content, not recipient delivery or draft removal.",
    usage: "--id <action-uuid> --key <observation-key>",
  },
  {
    command: "calendar.reconcile",
    id: true,
    flags: ["id", "key"],
    description:
      "Read back an uncertain Calendar operation under current read permissions. This never resends the write. Reuse the observation key after read approval; use a new key only for a deliberate later refresh. Only a succeeded state confirms the requested event state; notification delivery remains unverified.",
    usage: "--id <action-uuid> --key <stable-observation-key>",
  },
  {
    command: "calendar.create",
    id: false,
    flags: ["account", "calendar", "key", "notify", "event"],
    description:
      "Create an event after any required approval. Event JSON requires exactly summary, description, location, timing {kind: timed|all-day, start, end, timezone}, attendees [{email, displayName?, optional?}], recurrence [RRULE lines], and transparency opaque|transparent. Other event fields, including visibility, are not supported; ask before omitting a requested unsupported setting. Timed boundaries need explicit offsets; all-day end dates are exclusive. Reuse the exact key and fields after approval; never repeat an uncertain write.",
    usage:
      "--account <uuid> --calendar <calendar-id> --key <stable-key> --notify <all|externalOnly|none> --event <JSON>",
  },
  {
    command: "calendar.update",
    id: true,
    flags: ["account", "calendar", "key", "notify", "id", "etag", "scope", "changes"],
    description:
      "Change an event using its exact inspected ETag. Changes JSON is a nonempty subset of create fields. Scope JSON is {kind:single}, {kind:series}, or {kind:instance,recurringEventId,originalStartTime}. Instance scope affects only the selected occurrence. Inspection and mutation can require separate approvals; reuse the same key and arguments through both. Do not retry uncertainty with a new key.",
    usage:
      "--account <uuid> --calendar <calendar-id> --key <stable-key> --notify <all|externalOnly|none> --id <event-id> --etag <quoted-provider-etag> --scope <JSON> --changes <JSON>",
  },
  {
    command: "calendar.rsvp",
    id: true,
    flags: ["account", "calendar", "key", "notify", "id", "etag", "scope", "response"],
    description:
      "Respond only as the selected account's own attendee on an inspected invitation. Requires the exact ETag, explicit recurrence scope and notification intent. Other guests remain unchanged. Resume the exact key and arguments after approval; reconcile uncertainty instead of resending.",
    usage:
      "--account <uuid> --calendar <calendar-id> --key <stable-key> --notify <all|externalOnly|none> --id <event-id> --etag <quoted-provider-etag> --scope <JSON> --response <accepted|tentative|declined|needsAction>",
  },
  {
    command: "calendar.delete",
    id: true,
    flags: ["account", "calendar", "key", "notify", "id", "etag", "scope"],
    description:
      "Delete the exact inspected event version after any required approval. Scope JSON is {kind:single}, {kind:series}, or {kind:instance,recurringEventId,originalStartTime}. Series deletes all occurrences; instance deletes only the selected occurrence. Reuse the exact key and arguments after approval. An unknown outcome must be inspected, never resent.",
    usage:
      "--account <uuid> --calendar <calendar-id> --key <stable-key> --notify <all|externalOnly|none> --id <event-id> --etag <quoted-provider-etag> --scope <JSON>",
  },
  {
    command: "responsibilities.propose",
    description:
      "Propose ongoing work and pause for owner agreement. Reuse the same key after approval; a proposal does not start monitoring.",
    id: false,
    flags: ["key", "purpose", "scope"],
    usage: "--key <stable-key> --purpose <purpose> --scope <JSON-authorization-request-array>",
  },
  {
    command: "responsibilities.list",
    description: "List responsibility proposals and agreements.",
    id: false,
    flags: ["after"],
    usage: "[--after <uuid>]",
  },
  {
    command: "responsibilities.inspect",
    description: "Read the current purpose, scope and agreement revision.",
    id: true,
    flags: ["id"],
  },
  {
    command: "schedules.pause",
    description: "Pause future runs and cancel outstanding scheduled work.",
    id: true,
    flags: ["id", "revision"],
    usage: "--id <uuid> --revision <current-revision>",
  },
  {
    command: "schedules.resume",
    description: "Resume a paused schedule without replaying missed recurring runs.",
    id: true,
    flags: ["id", "revision"],
    usage: "--id <uuid> --revision <current-revision>",
  },
  {
    command: "schedules.create",
    description:
      "Create a durable reminder or recurring task. Reuse the same key after interruption.",
    id: false,
    flags: ["key", "objective", "at", "timezone", "rule", "responsibility", "agreement-revision"],
    usage:
      "--key <stable-key> --objective <task> --at <UTC-timestamp> [--timezone <IANA-zone>] [--rule <RRULE>] [--responsibility <uuid> --agreement-revision <number>]",
  },
  {
    command: "schedules.list",
    description: "List schedules and their revisions.",
    id: false,
    flags: ["after"],
    usage: "[--after <uuid>]",
  },
  {
    command: "schedules.inspect",
    description: "Inspect a schedule before changing it or recovering an interrupted request.",
    id: true,
    flags: ["id"],
  },
  {
    command: "schedules.update",
    description:
      "Replace a schedule using its current revision. Cancels outstanding work from the previous schedule.",
    id: true,
    flags: ["id", "revision", "objective", "at", "timezone", "rule"],
    usage:
      "--id <uuid> --revision <number> --objective <task> --at <UTC-timestamp> [--timezone <IANA-zone>] [--rule <RRULE>]",
  },
  {
    command: "schedules.cancel",
    description: "Cancel a schedule and its outstanding work using its current revision.",
    id: true,
    flags: ["id", "revision"],
    usage: "--id <uuid> --revision <number>",
  },
  {
    command: "files.send",
    description:
      "Queue a published artifact for delivery to the owner in Telegram. Reuse the same key on retry.",
    id: true,
    usage: "--id <artifact-uuid> --key <request-key>",
  },
  {
    command: "files.status",
    description: "Inspect a file delivery receipt. Only delivered confirms a successful send.",
    id: true,
  },
  {
    command: "files.publish",
    description:
      "Publish a completed staged file to private storage. Reuse the same key and unchanged file to recover its artifact reference.",
    id: false,
    flags: ["path", "key", "type"],
    usage: "--path <absolute-file-path> --key <request-key> [--type <media-type>]",
  },
  {
    command: "files.inspect",
    description:
      "Check a completed file in /data/home/artifacts and compute its size and checksum.",
    id: false,
    flags: ["path"],
    usage: "--path <absolute-file-path>",
  },
  {
    command: "gmail.search",
    description: "Search an explicitly selected Gmail account.",
    id: false,
    flags: ["account", "query", "limit", "cursor", "key"],
    usage:
      "--account <uuid> [--query <search>] [--limit <1-100>] [--cursor <json>] [--key <request-key>]",
  },
  {
    command: "gmail.draft-create",
    description:
      "Prepare an exact Gmail draft under the account's draft permission." + gmailMessageHelp,
    id: false,
    flags: ["account", "key", "message"],
    usage: "--account <uuid> --key <request-key> --message <json>",
  },
  {
    command: "gmail.draft-update",
    description:
      "Replace a reviewed draft version with exact message content. A version check cannot prevent a simultaneous provider edit." +
      gmailMessageHelp,
    id: true,
    flags: ["account", "key", "message", "id", "message-id"],
    usage:
      "--account <uuid> --key <request-key> --id <draft-id> --message-id <current-message-id> --message <json>",
  },
  {
    command: "gmail.send",
    description:
      "Send an exact message under the selected account's send permission." + gmailMessageHelp,
    id: false,
    flags: ["account", "key", "message"],
    usage: "--account <uuid> --key <request-key> --message <json>",
  },
  {
    command: "gmail.draft-send",
    description:
      "Send exact reviewed replacement content from a versioned draft. Gmail removes the draft after sending. A version check cannot prevent a simultaneous provider edit." +
      gmailMessageHelp,
    id: true,
    flags: ["account", "key", "message", "id", "message-id"],
    usage:
      "--account <uuid> --key <request-key> --id <draft-id> --message-id <current-message-id> --message <json>",
  },
  {
    command: "gmail.message",
    description: "Read one message from an explicitly selected Gmail account.",
    id: true,
    flags: ["account", "id", "key"],
    usage: "--account <uuid> --id <message-id> [--key <request-key>]",
  },
  {
    command: "gmail.drafts",
    description: "List drafts and their current message IDs in one Gmail account.",
    id: false,
    flags: ["account", "query", "limit", "cursor", "key"],
    usage:
      "--account <uuid> [--query <search>] [--limit <1-100>] [--cursor <json>] [--key <request-key>]",
  },
  {
    command: "gmail.draft",
    description: "Read a draft's current message, recipients and reply headers.",
    id: true,
    flags: ["account", "id", "key"],
    usage: "--account <uuid> --id <draft-id> [--key <request-key>]",
  },
  {
    command: "calendars.list",
    description: "List permitted calendars for one connected account.",
    id: false,
    flags: ["account"],
    usage: "--account <uuid>",
  },
  {
    command: "calendar.events",
    description: "Read a bounded event window, preserving all-day dates and cancellations.",
    id: false,
    flags: ["account", "calendar", "from", "until", "timezone", "query", "limit", "cursor", "key"],
    usage:
      "--account <uuid> --calendar <calendar-id> --from <timestamp> --until <timestamp> --timezone <IANA-zone> [--query <search>] [--limit <1-100>] [--cursor <json>] [--key <request-key>]",
  },
  {
    command: "calendar.availability",
    description: "Read busy intervals for one permitted calendar; unavailable is not free.",
    id: false,
    flags: ["account", "calendar", "from", "until", "timezone", "key"],
    usage:
      "--account <uuid> --calendar <calendar-id> --from <timestamp> --until <timestamp> --timezone <IANA-zone> [--key <request-key>]",
  },
  {
    command: "calendar.event",
    description: "Read one event from an explicitly selected calendar.",
    id: true,
    flags: ["account", "calendar", "id", "key"],
    usage: "--account <uuid> --calendar <calendar-id> --id <event-id> [--key <request-key>]",
  },
  {
    command: "accounts.connect",
    description:
      "Pause this task for the owner to connect an account. Does not grant access. Reuse the same key when checking the same request.",
    id: false,
  },
  {
    command: "accounts.list",
    description:
      "List account identities, labels and connection status. Discovery does not grant provider access.",
    id: false,
  },
  {
    command: "accounts.inspect",
    description:
      "Inspect one immutable account identity and its configured calendars, including reconnect status. Does not grant access.",
    id: true,
  },
  {
    command: "accounts.resolve",
    description:
      "Resolve an exact account label or email for one service. Ambiguous aliases require an explicit ID; disconnected accounts are never silently replaced.",
    id: false,
    usage: "--service <gmail|calendar> --alias <label-or-email>",
  },
  {
    command: "devices.list",
    description: "List proxy computers available to this task.",
    id: false,
  },
  { command: "devices.inspect", description: "Inspect one proxy computer.", id: true },
  {
    command: "devices.command",
    id: true,
    flags: ["id", "key", "cwd", "argv"],
    description:
      "Run a literal command on one proxy computer for up to 60 seconds. Waits for its result. Reuse the same key and arguments after approval; never repeat an uncertain effect.",
    usage: "--id <computer-uuid> --key <stable-key> --cwd <absolute-directory> --argv <JSON-array>",
  },
  {
    command: "devices.result",
    id: true,
    flags: ["id", "after"],
    description:
      "Read a device command's saved state and bounded output. Use afterSequence to retrieve remaining output when hasMore is true.",
    usage: "--id <action-uuid> [--after <sequence>]",
  },
  {
    command: "operations.inspect",
    description: "Read a recorded operation's current outcome.",
    id: true,
  },
  { command: "operations.cancel", description: "Request cancellation of one operation.", id: true },
] as const satisfies readonly {
  command: CliRequest["command"];
  description: string;
  id: boolean;
  flags?: readonly string[];
  usage?: string;
}[];

export function help(topic?: string) {
  const selected = commands.filter(
    (item) => !topic || item.command === topic || item.command.startsWith(`${topic}.`),
  );
  if (!selected.length) throw new Error("Unknown command. Run winston --help.");
  return {
    name: "winston",
    commands: selected.map((item) => ({
      usage: `winston ${item.command.replace(".", " ")}${"usage" in item ? ` ${item.usage}` : item.command === "accounts.connect" ? " --service <gmail|calendar> --key <request-key> --detail <reason> [--id <account-uuid>]" : item.id ? " --id <uuid>" : ""} [--json]`,
      description: item.description,
    })),
  };
}
