import type { CliRequest } from "@winston/contracts/cli";

export const commands = [
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
    flags: ["key", "objective", "at", "timezone", "rule"],
    usage:
      "--key <stable-key> --objective <task> --at <UTC-timestamp> [--timezone <IANA-zone>] [--rule <RRULE>]",
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
    command: "gmail.message",
    description: "Read one message from an explicitly selected Gmail account.",
    id: true,
    flags: ["account", "id", "key"],
    usage: "--account <uuid> --id <message-id> [--key <request-key>]",
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
    description: "List connected accounts available to this task.",
    id: false,
  },
  {
    command: "devices.list",
    description: "List proxy computers available to this task.",
    id: false,
  },
  { command: "devices.inspect", description: "Inspect one proxy computer.", id: true },
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
